import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { EmailAuthController } from './email-auth.controller';
import { EmailAuthService } from './email-auth.service';
import { StellarService } from './stellar.service';
import { AdminActivityRepository } from './admin-activity.repository';

function makeRes(): { cookie: jest.Mock; clearCookie: jest.Mock } {
  return { cookie: jest.fn(), clearCookie: jest.fn() };
}

function makeController(nodeEnv: string, sessionTtlSecs = 3600): EmailAuthController {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;

  const emailAuth = {
    verifyCode: jest.fn().mockResolvedValue({ address: 'G...', sessionToken: 'jwt' }),
    requestCode: jest.fn().mockResolvedValue(undefined),
    verifySession: jest.fn(),
  } as unknown as EmailAuthService;

  const config = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'sessionTtlSecs') return sessionTtlSecs;
      return undefined;
    }),
  } as unknown as ConfigService;

  const stellar = {} as unknown as StellarService;
  const activity = { record: jest.fn() } as unknown as AdminActivityRepository;

  const ctrl = new EmailAuthController(emailAuth, config, stellar, activity);
  process.env.NODE_ENV = originalEnv;
  return ctrl;
}

// ── #174: session cookie options ─────────────────────────────────────────────

describe('EmailAuthController cookie options', () => {
  it('verify sets polaris_session with httpOnly: true in dev mode', async () => {
    const ctrl = makeController('development');
    const res = makeRes();
    await ctrl.verify({ email: 'a@b.com', code: '123456' }, res as unknown as Response);
    expect(res.cookie).toHaveBeenCalledWith(
      'polaris_session',
      'jwt',
      expect.objectContaining({ httpOnly: true, path: '/' }),
    );
  });

  it('verify sets correct maxAge from sessionTtlSecs', async () => {
    const ctrl = makeController('development', 1800);
    const res = makeRes();
    await ctrl.verify({ email: 'a@b.com', code: '123456' }, res as unknown as Response);
    const opts = res.cookie.mock.calls[0][2];
    expect(opts.maxAge).toBe(1800 * 1000);
  });

  it('production mode sets secure: true and sameSite: none', async () => {
    const ctrl = makeController('production');
    const res = makeRes();
    await ctrl.verify({ email: 'a@b.com', code: '123456' }, res as unknown as Response);
    const opts = res.cookie.mock.calls[0][2];
    expect(opts.secure).toBe(true);
    expect(opts.sameSite).toBe('none');
  });

  it('dev mode sets secure: false and sameSite: lax', async () => {
    const ctrl = makeController('development');
    const res = makeRes();
    await ctrl.verify({ email: 'a@b.com', code: '123456' }, res as unknown as Response);
    const opts = res.cookie.mock.calls[0][2];
    expect(opts.secure).toBe(false);
    expect(opts.sameSite).toBe('lax');
  });

  it('logout calls clearCookie with the same options as verify', async () => {
    const ctrl = makeController('production', 3600);
    const verifyRes = makeRes();
    await ctrl.verify({ email: 'a@b.com', code: '123456' }, verifyRes as unknown as Response);
    const verifyOpts = verifyRes.cookie.mock.calls[0][2];

    const logoutRes = makeRes();
    ctrl.logout(logoutRes as unknown as Response);
    expect(logoutRes.clearCookie).toHaveBeenCalledWith('polaris_session', verifyOpts);
  });
});
