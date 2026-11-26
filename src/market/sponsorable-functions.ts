/**
 * Single source of truth for the contract functions that may be sponsored
 * (passkey prepare/submit and email trades). Keep in sync with
 * `AUTH_ADDRESS_PARAM` in wire-args.ts (checked by wire-args.spec.ts).
 */
export const SPONSORABLE_FUNCTIONS = ['buy', 'sell', 'split', 'merge', 'transfer', 'redeem'] as const;
export type SponsorableFunction = (typeof SPONSORABLE_FUNCTIONS)[number];
