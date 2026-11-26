import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { EmailAuthService } from './email-auth.service';
import { TradeActivityRecorder } from './trade-activity-recorder.service';
import { RequestEmailCodeDto } from './dto/request-email-code.dto';
import { VerifyEmailCodeDto } from './dto/verify-email-code.dto';
import { EmailTradeDto } from './dto/email-trade.dto';
import { messageOf } from './email-auth.message';

const SESSION_COOKIE = 'polaris_session';

/**
 * The email-login counterpart to `WalletController`'s passkey endpoints —
 * see `EmailAuthService`'s doc comment for why this exists and how it maps
 * onto the same on-chain wallet/relay machinery. The session is an
 * httpOnly cookie (never touched by frontend JS, so an XSS bug can't steal
 * it the way reading a token out of `localStorage` would allow) carrying a
 * signed JWT — stateless, no server-side session store needed beyond the
 * `email_wallets` row `trade` looks up to find the custodial key.
 */
@Controller('auth/email')
export class EmailAuthController {
  constructor(
    private readonly emailAuth: EmailAuthService,
    private readonly config: ConfigService,
    private readonly tradeRecorder: TradeActivityRecorder,
  ) {}

  @Post('request')
  @HttpCode(200)
  async request(@Body() dto: RequestEmailCodeDto) {
    try {
      await this.emailAuth.requestCode(dto.email);
    } catch (err) {
      throw new BadRequestException(messageOf(err));
    }
    return { sent: true };
  }

  @Post('verify')
  async verify(@Body() dto: VerifyEmailCodeDto, @Res({ passthrough: true }) res: Response) {
    let result: { address: string; sessionToken: string };
    try {
      result = await this.emailAuth.verifyCode(dto.email, dto.code);
    } catch (err) {
      throw new BadRequestException(messageOf(err));
    }
    res.cookie(SESSION_COOKIE, result.sessionToken, this.cookieOptions());
    return { address: result.address };
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, this.cookieOptions());
    return { ok: true };
  }

  /** Lets the frontend check "am I already signed in via email" on load, without re-sending a code. */
  @Get('me')
  me(@Req() req: Request) {
    const session = this.emailAuth.verifySession(readCookie(req, SESSION_COOKIE));
    if (!session) {
      throw new UnauthorizedException('session not found or expired');
    }
    return { email: session.email, address: session.address };
  }

  @Post('trade')
  async trade(@Req() req: Request, @Body() dto: EmailTradeDto) {
    const session = this.emailAuth.verifySession(readCookie(req, SESSION_COOKIE));
    if (!session) {
      throw new UnauthorizedException('session not found or expired — sign in again before trading');
    }
    let result: { txHash: string; walletAddress: string; status: 'success' | 'pending' };
    try {
      result = await this.emailAuth.signAndSubmitTrade(session.email, dto.contractId, dto.function, dto.args, dto.contractKind);
    } catch (err) {
      throw new BadRequestException(messageOf(err));
    }
    // Best-effort admin-dashboard logging, fire-and-forget (see TradeActivityRecorder).
    this.tradeRecorder.recordTrade({
      contractId: dto.contractId,
      function: dto.function,
      args: dto.args,
      contractKind: dto.contractKind,
      walletAddress: result.walletAddress,
      txHash: result.txHash,
      source: 'email',
    });
    return { txHash: result.txHash };
  }

  /**
   * POST /email/export-key — re-authenticated custodial key export (issue #183).
   *
   * Returns the secp256r1 private key as a hex-encoded SEC1 DER bytes so the
   * user can import it into any P-256-capable self-custody wallet.
   * Rate-limited to 3 requests per hour; every export is audit-logged.
   */
  @Post('export-key')
  @HttpCode(200)
  exportKey(@Req() req: Request) {
    const session = this.emailAuth.verifySession(readCookie(req, SESSION_COOKIE));
    if (!session) {
      throw new UnauthorizedException('not signed in');
    }
    let result: { privateKeyHex: string; walletAddress: string };
    try {
      result = this.emailAuth.exportPrivateKey(session.email);
    } catch (err) {
      throw new BadRequestException(messageOf(err));
    }
    return result;
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      secure: this.config.get<boolean>('cookieSecure')!,
      sameSite: this.config.get<'none' | 'lax'>('cookieSameSite')!,
      maxAge: this.config.get<number>('sessionTtlSecs')! * 1000,
      path: '/',
    };
  }
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        // A malformed percent-encoding (e.g. a stray/tampered cookie) must
        // not 500 the request — treat it as "no session cookie" instead.
        return undefined;
      }
    }
  }
  return undefined;
}
