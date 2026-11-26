import { StrKey } from '@stellar/stellar-sdk';

/**
 * Wallet addresses in this system are smart-wallet contract instances (a
 * `C...` strkey), but some are also looked up by ordinary account keys
 * (`G...`) or the muxed form (`M...`) depending on the caller. Accepts any
 * of those three real Stellar address encodings; rejects anything else
 * (garbage, SQL/command-injection attempts, empty strings) *before* it
 * reaches an RPC call, instead of letting a malformed value be the first
 * thing the RPC node sees.
 */
export function isValidStellarAddress(address: string): boolean {
  if (!address || typeof address !== 'string') return false;
  return (
    StrKey.isValidContract(address) ||
    StrKey.isValidEd25519PublicKey(address) ||
    StrKey.isValidMed25519PublicKey(address)
  );
}
