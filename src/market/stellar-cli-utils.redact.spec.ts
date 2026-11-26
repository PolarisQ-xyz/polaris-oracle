import { redactSecrets, sanitizeCliError } from './stellar-cli-utils';

const SECRET = 'S' + 'A'.repeat(55);

describe('redactSecrets / sanitizeCliError', () => {
  it('redacts StrKey secrets', () => {
    expect(redactSecrets(`--source ${SECRET} --network x`)).toBe('--source [REDACTED] --network x');
  });

  it('produces no secret in the message when execFile failed without stderr', () => {
    const err = Object.assign(new Error(`Command failed: stellar contract deploy --source ${SECRET}`), { code: 1 });
    const out = sanitizeCliError(err);
    expect(out.message).not.toContain(SECRET);
    expect(out.message).toContain('Command failed');
  });

  it('prefers the stderr summary line and keeps redacted stderr', () => {
    const err = Object.assign(new Error(`Command failed: ... ${SECRET}`), {
      stderr: `ℹ️ working\n❌ error: boom ${SECRET}\n`,
    });
    const out = sanitizeCliError(err) as Error & { stderr?: string };
    expect(out.message).toBe('❌ error: boom [REDACTED]');
    expect(out.stderr).not.toContain(SECRET);
  });
});
