import { randomBytes } from 'node:crypto';
import { decryptAtRest, encryptAtRest } from './email-crypto';

// Pure-function tests against the real AES-256-GCM code path. email-auth.service.spec.ts
// mocks this layer, so these are the only tests that exercise the actual cipher.

const KEY_HEX = '11'.repeat(32);
const OTHER_KEY_HEX = '22'.repeat(32);

function flipByte(blob: string, index: number): string {
  const raw = Buffer.from(blob, 'base64');
  raw[index] ^= 0x01;
  return raw.toString('base64');
}

describe('email-crypto encryptAtRest / decryptAtRest', () => {
  it.each([0, 1, 15, 16, 17, 32, 64, 1024])('round-trips a %i-byte plaintext', (size) => {
    const plaintext = randomBytes(size);
    const blob = encryptAtRest(plaintext, KEY_HEX);

    expect(decryptAtRest(blob, KEY_HEX).equals(plaintext)).toBe(true);
  });

  it('throws when a ciphertext byte is flipped (GCM integrity)', () => {
    const blob = encryptAtRest(Buffer.from('secret-private-key-material'), KEY_HEX);

    expect(() => decryptAtRest(flipByte(blob, 28), KEY_HEX)).toThrow();
  });

  it('throws when an authTag byte is flipped (GCM integrity)', () => {
    const blob = encryptAtRest(Buffer.from('secret-private-key-material'), KEY_HEX);

    expect(() => decryptAtRest(flipByte(blob, 12), KEY_HEX)).toThrow();
  });

  it('throws rather than returning garbage under a different key', () => {
    const blob = encryptAtRest(Buffer.from('secret-private-key-material'), KEY_HEX);

    expect(() => decryptAtRest(blob, OTHER_KEY_HEX)).toThrow();
  });

  it('produces different blobs for the same plaintext (fresh random IV per call)', () => {
    const plaintext = Buffer.from('same-plaintext');

    expect(encryptAtRest(plaintext, KEY_HEX)).not.toBe(encryptAtRest(plaintext, KEY_HEX));
  });
});
