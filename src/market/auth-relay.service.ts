import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { StellarService } from './stellar.service';
import {
  BASE_FEE,
  Contract,
  TransactionBuilder,
  authorizeEntry,
  buildAuthorizationEntryPreimage,
  hash,
  inspectAuthEntry,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import type { contract } from '@stellar/stellar-sdk';
import { marketSpec, perpetualSpec } from './contracts';
import { buildSponsoredCallArgs, type WireArgs } from './wire-args';
import type { ContractKind } from './dto/prepare-auth.dto';
import { getAccountLock, type AsyncLock } from './account-lock';

/** `polaris-market`/`polaris-perpetual` share every sponsorable function's
 * name and shape (see `polaris-contracts/README.md`'s "The perpetual
 * contract") — the only thing that differs per contract kind is which
 * compiled spec `buildSponsoredCallArgs` encodes `wireArgs` against. */
function specFor(kind: ContractKind | undefined): contract.Spec {
  return kind === 'perpetual' ? perpetualSpec : marketSpec;
}

export interface PrepareAuthResult {
  entryXdr: string;
  signaturePayloadHex: string;
  validUntilLedgerSeq: number;
}

export interface WebAuthnAssertion {
  authenticatorDataHex: string;
  clientDataJsonBase64: string;
  /** Raw 64-byte r‖s ECDSA signature, DER-decoded and low-S normalized client-side. */
  signatureHex: string;
}

/**
 * Sponsors transactions authorized by a passkey smart-wallet address instead
 * of a classic keypair: this process pays the fee (its own keypair signs the
 * transaction *envelope*, a normal Stellar source-account signature), while
 * the wallet's own Soroban authorization entry is signed by the user's
 * passkey in the browser.
 *
 * Necessarily two HTTP round-trips, because "signing" here means a Face
 * ID/Touch ID prompt in the user's browser — there's no synchronous
 * in-process callback to hand a signer, unlike a normal `Keypair`:
 *
 * 1. `prepare()` — builds the call, simulates it (letting the host
 *    auto-record which addresses need to authorize what), and returns the
 *    32-byte hash the passkey needs to sign plus the exact (unsigned)
 *    authorization entry XDR that hash was derived from.
 * 2. `submit()` — takes that same entry XDR back (unchanged — its nonce and
 *    invocation tree must match exactly what was hashed in step 1) plus the
 *    resulting WebAuthn assertion, attaches it as the entry's signature via
 *    `authorizeEntry`, rebuilds the operation with that entry attached from
 *    the start (rather than mutating a parsed transaction's internals,
 *    which the SDK does not document as safe), and submits.
 *
 * Verified: passkey and email-wallet trades have been exercised end-to-end
 * on testnet. Mainnet operation remains untested; treat mainnet as
 * unverified until a live mainnet trade confirms the relay path.
 */
@Injectable()
export class AuthRelayService {
  private readonly logger = new Logger(AuthRelayService.name);
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  /**
   * Shared with `StellarService` (keyed by the same `ORACLE_SECRET_KEY`
   * secret — see account-lock.ts) because `submit()` below fetches this
   * same source account's sequence number and submits a transaction from
   * it, exactly like `StellarService.settle`/`cancel`/etc. Without sharing
   * the lock, a sponsored-auth submit racing an oracle settle/cancel could
   * each read the same sequence number before either submits.
   */
  private readonly accountLock: AsyncLock;

  constructor(private readonly stellar: StellarService) {
    this.server = stellar.server;
    this.networkPassphrase = stellar.networkPassphrase;
  }

  /**
   * Inclusion fee for a sponsored transaction, derived from the network's
   * current fee climate rather than hardcoded `BASE_FEE` — under surge
   * pricing, a flat minimum fee just sits unincluded until the relay's
   * poll gives up, with no clear cause to the caller. Uses the p70 bucket
   * of `getFeeStats()`'s Soroban inclusion-fee distribution, capped by
   * `maxInclusionFeeStroops` so a fee spike can't blow sponsor cost out
   * unbounded. Falls back to `BASE_FEE` if the stats call itself fails —
   * this must never become a new way to block a sponsored transaction.
   */
  private async inclusionFee(): Promise<string> {
    const cap = this.config.get<number>('maxInclusionFeeStroops') ?? 100_000;
    try {
      const stats = await this.server.getFeeStats();
      const p70 = Number(stats.sorobanInclusionFee?.p70 ?? BASE_FEE);
      const fee = Math.max(Number(BASE_FEE), Math.min(p70, cap));
      return String(fee);
    } catch (err) {
      this.logger.warn(`getFeeStats failed, falling back to BASE_FEE: ${(err as Error).message}`);
      return BASE_FEE;
    }
  }

  /**
   * Step 1 of the two-round-trip sponsored relay: simulates the contract call,
   * records which Soroban auth entries the wallet address must sign, and returns
   * the 32-byte hash the passkey needs to sign plus the unsigned entry XDR.
   * No network transaction is submitted here — this is read-only simulation.
   * The entry XDR's nonce and invocation tree must be passed back unchanged to
   * `submit()`; mutating it invalidates the hash the passkey already signed.
   * Note: `contractId` has no allowlist check here; callers should validate it
   * against a known-safe list before invoking (see issue #27).
   */
  async prepare(
    walletAddress: string,
    contractId: string,
    functionName: string,
    wireArgs: WireArgs,
    contractKind?: ContractKind,
  ): Promise<PrepareAuthResult> {
    const scArgs = buildSponsoredCallArgs(specFor(contractKind), functionName, walletAddress, wireArgs);
    const op = new Contract(contractId).call(functionName, ...scArgs);

    const sourceAccount = await this.server.getAccount(this.stellar.oraclePublicKey);
    const tx = new TransactionBuilder(sourceAccount, {
      fee: await this.inclusionFee(),
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(120)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new BadRequestException(`simulation failed: ${sim.error}`);
    }
    if (!rpc.Api.isSimulationSuccess(sim)) {
      throw new BadRequestException(`simulation did not succeed (status: ${(sim as { status?: string }).status ?? 'unknown'} — expected success, got restore?`);
    }

    const entries = sim.result?.auth ?? [];
    const match = entries.find((e) => {
      const info = inspectAuthEntry(e);
      return info.address === walletAddress;
    });
    if (!match) {
      throw new BadRequestException(
        `no authorization entry for ${walletAddress} was recorded for ${functionName} — check the arg that should carry this address`,
      );
    }

    const latestLedger = await this.server.getLatestLedger();
    const validUntilLedgerSeq = latestLedger.sequence + 120; // ~10 minutes at 5s/ledger

    const preimage = buildAuthorizationEntryPreimage(match, validUntilLedgerSeq, this.networkPassphrase);
    const signaturePayload = hash(preimage.toXDR());

    return {
      entryXdr: match.toXDR('base64'),
      signaturePayloadHex: signaturePayload.toString('hex'),
      validUntilLedgerSeq,
    };
  }

  /**
   * Step 2 of the two-round-trip sponsored relay: attaches the WebAuthn
   * assertion to the unsigned auth entry returned by `prepare`, rebuilds the
   * sponsored transaction, and submits it.  The wallet address is read back
   * from the entry XDR itself (not from a client-supplied field) to prevent
   * spoofing. Calls `pollTransaction` internally to await confirmation.
   */
  async submit(
    contractId: string,
    functionName: string,
    wireArgs: WireArgs,
    entryXdr: string,
    validUntilLedgerSeq: number,
    assertion: WebAuthnAssertion,
    contractKind?: ContractKind,
  ): Promise<{ txHash: string; walletAddress: string }> {
    const unsignedEntry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64');

    // Read the authorizing address back out of the entry itself rather than
    // trust a client-supplied field for it: the entry is what's actually
    // being signed and submitted, so it's the one value here that can't be
    // spoofed or drift out of sync with what the passkey approved.
    const walletAddress = inspectAuthEntry(unsignedEntry).address;
    if (!walletAddress) {
      throw new BadRequestException('entryXdr has no address credentials to authorize against');
    }

    const signatureScVal = buildWebAuthnSignatureScVal(assertion);
    const signedEntry = await authorizeEntry(
      unsignedEntry,
      async () => ({ signatureScVal }),
      validUntilLedgerSeq,
      this.networkPassphrase,
    );

    const scArgs = buildSponsoredCallArgs(specFor(contractKind), functionName, walletAddress, wireArgs);
    const op = new Contract(contractId).call(functionName, ...scArgs);
    op.body().invokeHostFunctionOp().auth([signedEntry]);

    const sourceAccount = await this.server.getAccount(this.stellar.oraclePublicKey);
    let tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(60)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new BadRequestException(`simulation failed: ${sim.error}`);
    }
    tx = rpc.assembleTransaction(tx, sim).build();
    this.stellar.signAsSponsor(tx);

      const sendRes = await this.server.sendTransaction(tx);
      if (sendRes.status === 'ERROR') {
        throw new BadRequestException(`submit failed: ${JSON.stringify(sendRes.errorResult)}`);
      }

      const finalRes = await this.pollTransaction(sendRes.hash);
      if (finalRes.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new BadRequestException(`transaction ${sendRes.hash} did not succeed: ${finalRes.status}`);
      }

      return { txHash: sendRes.hash, walletAddress };
    });
  }

  /**
   * Polls the RPC node until the transaction is no longer `NOT_FOUND`
   * (i.e. included in a ledger or failed), retrying up to `attempts` times
   * with `delayMs` between each check. Throws if the transaction is never
   * confirmed within the attempt budget.
   */
  private async pollTransaction(txHash: string, attempts = 30, delayMs = 2000): Promise<rpc.Api.GetTransactionResponse> {
    for (let i = 0; i < attempts; i++) {
      const res = await this.server.getTransaction(txHash);
      if (res.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
        return res;
      }
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return { status: rpc.Api.GetTransactionStatus.NOT_FOUND } as rpc.Api.GetTransactionResponse;
  }
}

/**
 * Builds the `Signature` struct ScVal (`{authenticator_data, client_data_json,
 * signature}`, field order/shape confirmed against the compiled smart-wallet
 * contract's own spec — see `contracts.ts` — rather than assumed) that
 * `authorizeEntry`'s `signatureScVal` callback result is written verbatim
 * into the credentials' signature field.
 */
function buildWebAuthnSignatureScVal(assertion: WebAuthnAssertion): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('authenticator_data'),
      val: xdr.ScVal.scvBytes(Buffer.from(assertion.authenticatorDataHex, 'hex')),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('client_data_json'),
      val: xdr.ScVal.scvBytes(Buffer.from(assertion.clientDataJsonBase64, 'base64')),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('signature'),
      val: xdr.ScVal.scvBytes(Buffer.from(assertion.signatureHex, 'hex')),
    }),
  ]);
}
