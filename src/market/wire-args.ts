import { BadRequestException } from '@nestjs/common';
import { contract as StellarContract, type xdr } from '@stellar/stellar-sdk';
import { SPONSORABLE_FUNCTIONS, type SponsorableFunction } from './sponsorable-functions';

const SIGNED_INT_RE = /^-?\d+$/;
const UNSIGNED_INT_RE = /^\d+$/;
const HEX_RE = /^([0-9a-fA-F]{2})*$/;

const UNSIGNED_INT_TYPES = new Set(['scSpecTypeU128', 'scSpecTypeU64']);

/**
 * JSON-transportable argument values from an HTTP request body: plain
 * numbers don't survive i128/u64 precision, and Buffers don't survive JSON
 * at all, so the wire convention is decimal-string for big integers,
 * hex-string for bytes, and plain strings for everything else (addresses,
 * the `Prediction` enum tag).
 */
export type WireArgs = Record<string, string | number>;

/**
 * Which parameter each sponsorable function's authorizing address is bound
 * to — `transfer` calls it `from` (there's a second, unrelated `to`
 * address in that call); every other function calls it `user`. This isn't
 * cosmetic: `coerceWireArgs` silently *skips* any parameter absent from
 * `wireArgs` rather than erroring, so if a caller forgets to include the
 * address under this exact key, the resulting call doesn't fail loudly —
 * it quietly builds with `scvVoid` where an `Address` belongs, and breaks
 * downstream instead (verified against `spec.js`, not assumed). An earlier
 * version of this system's callers never included the address at all,
 * which would have broken every trade end-to-end; see
 * `wire-args.spec.ts` for the regression test.
 */
export const AUTH_ADDRESS_PARAM: Record<string, string> = {
  buy: 'user',
  sell: 'user',
  split: 'user',
  merge: 'user',
  redeem: 'user',
  transfer: 'from',
};

export { SPONSORABLE_FUNCTIONS };
export type { SponsorableFunction };

/**
 * Which wire-arg key holds the amount `apply_fee` charges its bps against,
 * per function — `buy`'s fee is on the collateral going in
 * (`collateral_amount`), `sell`'s is on the shares going in (`shares_in`),
 * matching the contract's own `effective_in = apply_fee(...)` call in each
 * (see `polaris-ctf-math::apply_fee`). Only `buy`/`sell` ever charge a fee
 * at all (`split`/`merge`/`redeem`/`transfer` never call `apply_fee`), so
 * this is deliberately not defined for those.
 *
 * Found live: `wallet.controller.ts`/`email-auth.controller.ts` only ever
 * checked `collateral_amount`, so every `sell`'s fee-revenue row was
 * silently recorded with no `collateral_amount` (`AdminController.
 * feeRevenue()` skips rows where it's `null`) — sell fees were never
 * counted, for every market and perpetual, since this dashboard shipped.
 */
const FEE_BEARING_AMOUNT_PARAM: Partial<Record<string, string>> = {
  buy: 'collateral_amount',
  sell: 'shares_in',
};

/** The fee-bearing amount from `args` for `functionName`, or `undefined` if that function never charges a fee (or the expected key is absent). */
export function feeBearingAmount(functionName: string, args: WireArgs): string | undefined {
  const key = FEE_BEARING_AMOUNT_PARAM[functionName];
  if (!key) return undefined;
  const value = args[key];
  return typeof value === 'undefined' ? undefined : String(value);
}

/**
 * Builds the exact `xdr.ScVal[]` a sponsored call to `functionName` needs,
 * with `walletAddress` injected under whichever parameter actually
 * authorizes the call (see `AUTH_ADDRESS_PARAM`) — the single choke point
 * both `prepare()` and `submit()` go through, so the address-injection
 * logic only exists once and is directly unit-testable without any RPC
 * mocking at all.
 */
export function buildSponsoredCallArgs(
  spec: StellarContract.Spec,
  functionName: string,
  walletAddress: string,
  wireArgs: WireArgs,
): xdr.ScVal[] {
  const addressParam = AUTH_ADDRESS_PARAM[functionName];
  if (!addressParam) {
    throw new Error(`${functionName} is not a sponsorable function`);
  }
  const args = coerceWireArgs(spec, functionName, { ...wireArgs, [addressParam]: walletAddress });
  return spec.funcArgsToScVals(functionName, args);
}

/**
 * Converts wire-format args into whatever `contract.Spec.funcArgsToScVals`
 * expects, by reflecting on the target function's own parameter types —
 * rather than hardcoding a conversion table per function — so this stays
 * correct if the contract's function signatures change.
 */
export function coerceWireArgs(
  spec: StellarContract.Spec,
  functionName: string,
  wireArgs: WireArgs,
): Record<string, unknown> {
  const func = spec.getFunc(functionName);
  const out: Record<string, unknown> = {};
  const validNames = new Set(func.inputs().map((input) => input.name().toString()));
  for (const key of Object.keys(wireArgs)) {
    if (!validNames.has(key)) {
      throw new BadRequestException(`unknown arg: ${key}`);
    }
  }

  for (const input of func.inputs()) {
    const name = input.name().toString();
    if (!(name in wireArgs)) {
      continue;
    }
    const raw = wireArgs[name];
    const typeName = input.type().switch().name as string;

    switch (typeName) {
      case 'scSpecTypeI128':
      case 'scSpecTypeU128':
      case 'scSpecTypeI64':
      case 'scSpecTypeU64': {
        const re = UNSIGNED_INT_TYPES.has(typeName) ? UNSIGNED_INT_RE : SIGNED_INT_RE;
        if (typeof raw !== 'string' || !re.test(raw)) {
          const kind = UNSIGNED_INT_TYPES.has(typeName) ? 'a non-negative integer' : 'an integer';
          throw new BadRequestException(`${name} must be ${kind} string`);
        }
        out[name] = BigInt(raw);
        break;
      }
      case 'scSpecTypeBytes':
      case 'scSpecTypeBytesN':
        if (typeof raw !== 'string' || !HEX_RE.test(raw)) {
          throw new BadRequestException(`${name} must be a valid hex string`);
        }
        out[name] = Buffer.from(raw, 'hex');
        break;
      case 'scSpecTypeUdt': {
        const udtName = input.type().udt().name().toString();
        if (udtName === 'Prediction') {
          out[name] = { tag: raw as string, values: undefined };
        } else {
          out[name] = raw;
        }
        break;
      }
      default:
        out[name] = raw;
    }
  }

  return out;
}
