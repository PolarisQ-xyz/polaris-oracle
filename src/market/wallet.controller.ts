import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { StellarService } from './stellar.service';
import { isValidStellarAddress } from './stellar-address';
import { AuthRelayService } from './auth-relay.service';
import { WalletDeployRateLimiter } from './wallet-deploy-rate-limiter.service';
import { TradeActivityRecorder } from './trade-activity-recorder.service';
import { DeployWalletDto } from './dto/deploy-wallet.dto';
import { ResolveWalletQueryDto } from './dto/resolve-wallet-query.dto';
import { PrepareAuthDto } from './dto/prepare-auth.dto';
import { SubmitAuthDto } from './dto/submit-auth.dto';

/**
 * Passkey smart-wallet endpoints: gasless deploy (this process pays), and
 * the two-step sponsored-transaction relay (`prepare` / `submit`) described
 * in `AuthRelayService`.
 */
@Controller('wallets')
export class WalletController {
  constructor(
    private readonly stellar: StellarService,
    private readonly relay: AuthRelayService,
    private readonly config: ConfigService,
    private readonly deployRateLimiter: WalletDeployRateLimiter,
    private readonly tradeRecorder: TradeActivityRecorder,
  ) {}

  /**
   * The address a passkey with this public key resolves to, whether or not
   * it's been deployed yet — the "portable identity" lookup: a caller can
   * check this before deciding whether to prompt registration or just sign
   * a bettor in. Free (a simulated read), not a transaction.
   */
  @Get('resolve')
  async resolve(@Query() query: ResolveWalletQueryDto) {
    const factoryId = this.config.get<string>('smartWalletFactoryContract');
    if (!factoryId) {
      throw new BadRequestException('SMART_WALLET_FACTORY_CONTRACT must be configured to resolve wallets');
    }
    const address = await this.stellar.resolveWallet(factoryId, Buffer.from(query.publicKeyHex, 'hex'));
    return { address };
  }

  /**
   * Spendable native-XLM balance, in stroops, for any wallet address —
   * passkey or email-custodial, same shape either way since both are
   * ordinary smart-wallet contract instances. Powers the header's balance
   * display next to a signed-in wallet; free (a simulated SEP-41 `balance`
   * read), not a transaction.
   */
  @Get('balance')
  async balance(@Query('address') address: string) {
    if (!address) {
      throw new BadRequestException('address query param is required');
    }
    if (!isValidStellarAddress(address)) {
      throw new BadRequestException('address query param is not a valid Stellar address');
    }
    const nativeXlmSac = this.config.get<string>('nativeXlmSac');
    if (!nativeXlmSac) {
      throw new BadRequestException('NATIVE_XLM_SAC must be configured to read wallet balances');
    }
    const balanceStroops = await this.stellar.tokenBalance(nativeXlmSac, address);
    return { balanceStroops: balanceStroops.toString() };
  }

  @Post('deploy')
  async deploy(@Req() req: Request, @Body() dto: DeployWalletDto) {
    if (!this.deployRateLimiter.tryConsume(req.ip ?? 'unknown')) {
      throw new HttpException('wallet deploy rate limit exceeded — try again in an hour', HttpStatus.TOO_MANY_REQUESTS);
    }
    const factoryId = this.config.get<string>('smartWalletFactoryContract');
    if (!factoryId) {
      throw new BadRequestException('SMART_WALLET_FACTORY_CONTRACT must be configured to deploy wallets');
    }
    const address = await this.stellar.deployWallet(factoryId, Buffer.from(dto.publicKeyHex, 'hex'));
    return { address };
  }

  /** Lets a caller keep polling a submitted tx's confirmation without holding the submit request open — see AuthRelayService.submit's doc comment. */
  @Get('tx/:hash')
  async txStatus(@Param('hash') txHash: string) {
    if (!/^[0-9a-f]{64}$/i.test(txHash)) {
      throw new BadRequestException('hash must be 64 hex characters');
    }
    return this.relay.txStatus(txHash);
  }

  @Post('tx/prepare')
  async prepare(@Body() dto: PrepareAuthDto) {
    return this.relay.prepare(dto.walletAddress, dto.contractId, dto.function, dto.args, dto.contractKind);
  }

  @Post('tx/submit')
  async submit(@Body() dto: SubmitAuthDto) {
    const result = await this.relay.submit(
      dto.contractId,
      dto.function,
      dto.args,
      dto.entryXdr,
      dto.validUntilLedgerSeq,
      {
        authenticatorDataHex: dto.assertion.authenticatorDataHex,
        clientDataJsonBase64: dto.assertion.clientDataJsonBase64,
        signatureHex: dto.assertion.signatureHex,
      },
      dto.contractKind,
    );
    // Best-effort admin-dashboard logging, fire-and-forget (see TradeActivityRecorder).
    this.tradeRecorder.recordTrade({
      contractId: dto.contractId,
      function: dto.function,
      args: dto.args,
      contractKind: dto.contractKind,
      walletAddress: result.walletAddress,
      txHash: result.txHash,
      source: 'passkey',
    });
    return { txHash: result.txHash };
  }
}
