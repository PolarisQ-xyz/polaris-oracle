import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { EmailAuthService } from './email-auth.service';

// Hand-rolled fakes rather than a Nest TestingModule — mirrors the pattern
// used elsewhere in this repo (see market.service.spec.ts) for keeping unit
// tests fast and independent of the real Stellar SDK / relay.

function config(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    emailCodeResendCooldownSecs: 60,
    emailCodeTtlSecs: 600,
    emailCodeMaxAttempts: 5,
    sessionJwtSecret: 'test-session-secret',
    sessionTtlSecs: 3600,
    smartWalletFactoryContract: 'FACTORY',
    smartWalletWasmHash: '00'.repeat(32),
    emailWalletEncKeyHex: '11'.repeat(32),
    ...overrides,
  };
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

function pendingCodeRepo(email: string, code: string) {
  const codeHash = createHash('sha256').update(code).digest('hex');
  return {
    getCode: jest.fn().mockReturnValue({
      email,
      code_hash: codeHash,
      expires_at: Date.now() + 10_000,
      attempts: 0,
      created_at: Date.now(),
    }),
    deleteCode: jest.fn(),
    incrementAttempts: jest.fn(),
    getWallet: jest.fn().mockReturnValue(undefined),
    saveWallet: jest.fn(),
  };
}

describe('EmailAuthService — auto-funding a freshly created wallet', () => {
  // Regression for: a brand-new custodial wallet deploys on-chain with 0
  // XLM, and `buy` pulls its collateral straight from the wallet's own
  // balance — without this, every first-time email login's very first
  // trade failed on an opaque "insufficient balance" simulation error.
  it('funds a newly deployed wallet via the faucet', async () => {
    const email = 'bettor@example.com';
    const code = '654321';
    const repo = pendingCodeRepo(email, code);
    const stellar = { deployWallet: jest.fn().mockResolvedValue('CNEWWALLETADDRESS') };
    const relay = {};
    const faucet = {
      tryConsume: jest.fn().mockReturnValue(true),
      fund: jest.fn().mockResolvedValue({ funded: true, alreadyExists: false }),
    };
    const sender = { send: jest.fn() };

    const svc = new EmailAuthService(
      config(),
      repo as any,
      stellar as any,
      relay as any,
      faucet as any,
      sender as any,
    );

    const result = await svc.verifyCode(email, code);

    expect(result.address).toBe('CNEWWALLETADDRESS');
    expect(faucet.tryConsume).toHaveBeenCalledWith('CNEWWALLETADDRESS');
    expect(faucet.fund).toHaveBeenCalledWith('CNEWWALLETADDRESS');
  });

  it('does not fail login if the faucet is down', async () => {
    const email = 'bettor2@example.com';
    const code = '111222';
    const repo = pendingCodeRepo(email, code);
    const stellar = { deployWallet: jest.fn().mockResolvedValue('CNEWWALLETADDRESS2') };
    const relay = {};
    const faucet = {
      tryConsume: jest.fn().mockReturnValue(true),
      fund: jest.fn().mockRejectedValue(new Error('friendbot funding failed: 503')),
    };
    const sender = { send: jest.fn() };

    const svc = new EmailAuthService(
      config(),
      repo as any,
      stellar as any,
      relay as any,
      faucet as any,
      sender as any,
    );

    await expect(svc.verifyCode(email, code)).resolves.toMatchObject({ address: 'CNEWWALLETADDRESS2' });
  });

  it('does not re-fund or re-deploy for a returning email login', async () => {
    const email = 'returning@example.com';
    const code = '999888';
    const repo = pendingCodeRepo(email, code);
    repo.getWallet.mockReturnValue({
      email,
      address: 'CEXISTINGWALLET',
      public_key_hex: 'ab',
      encrypted_private_key: 'ciphertext',
      created_at: Date.now(),
    });
    const stellar = { deployWallet: jest.fn() };
    const relay = {};
    const faucet = { tryConsume: jest.fn(), fund: jest.fn() };
    const sender = { send: jest.fn() };

    const svc = new EmailAuthService(
      config(),
      repo as any,
      stellar as any,
      relay as any,
      faucet as any,
      sender as any,
    );

    const result = await svc.verifyCode(email, code);

    expect(result.address).toBe('CEXISTINGWALLET');
    expect(stellar.deployWallet).not.toHaveBeenCalled();
    expect(faucet.tryConsume).not.toHaveBeenCalled();
  });
});

describe('EmailAuthService.requestCode — resend cooldown', () => {
  const email = 'cooldown@example.com';
  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

  // In-memory stand-in for EmailAuthRepository with the same upsert semantics as saveCode.
  function setup() {
    const rows = new Map<string, any>();
    const repo = {
      getCode: jest.fn((e: string) => rows.get(e)),
      saveCode: jest.fn((e: string, codeHash: string, expiresAt: number) => {
        rows.set(e, { email: e, code_hash: codeHash, expires_at: expiresAt, attempts: 0, created_at: Date.now() });
      }),
      deleteCode: jest.fn((e: string) => rows.delete(e)),
      incrementAttempts: jest.fn(),
      getWallet: jest.fn().mockReturnValue(undefined),
      saveWallet: jest.fn(),
    };
    const stellar = { deployWallet: jest.fn().mockResolvedValue('CWALLET') };
    const faucet = { tryConsume: jest.fn().mockReturnValue(false), fund: jest.fn() };
    const sender = { send: jest.fn() };
    const svc = new EmailAuthService(config(), repo as any, stellar as any, {} as any, faucet as any, sender as any);
    const sentCode = (call: number) => /sign-in code is (\d{6})/.exec(sender.send.mock.calls[call][2])![1];
    return { svc, rows, sender, sentCode };
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejects a second request inside the cooldown with the remaining wait, without sending', async () => {
    const { svc, sender } = setup();
    await svc.requestCode(email);

    jest.advanceTimersByTime(20_000);
    await expect(svc.requestCode(email)).rejects.toThrow('Please wait 40s');
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it('allows a request after the cooldown and replaces the stored code', async () => {
    const { svc, sender, sentCode } = setup();
    await svc.requestCode(email);
    const oldCode = sentCode(0);

    jest.advanceTimersByTime(60_000);
    await svc.requestCode(email);
    expect(sender.send).toHaveBeenCalledTimes(2);
    const newCode = sentCode(1);

    // 1-in-900k chance the random codes collide; skip the stale-code check then.
    if (oldCode !== newCode) {
      await expect(svc.verifyCode(email, oldCode)).rejects.toThrow('Incorrect code.');
    }
    await expect(svc.verifyCode(email, newCode)).resolves.toMatchObject({ address: 'CWALLET' });
  });

  it('stores the SHA-256 of the code, never the plaintext', async () => {
    const { svc, rows, sentCode } = setup();
    await svc.requestCode(email);

    const code = sentCode(0);
    const row = rows.get(email);
    expect(row.code_hash).toBe(sha256(code));
    expect(row.code_hash).not.toContain(code);
  });
});
