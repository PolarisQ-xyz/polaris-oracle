export interface AppConfig {
  port: number;
  oracleSecretKey: string;
  /** Optional separate identity for market deployment only — falls back to `oracleSecretKey` if unset. See `StellarService`'s `deployerKeypair` doc comment for why splitting this out is safe and worth it. */
  deployerSecretKey: string | undefined;
  adminApiKey: string;
  pythLazerToken: string | undefined;
  pythLazerWsUrl: string;
  pythHermesUrl: string;
  corsOrigins: string[];
  stellarRpcUrl: string;
  stellarNetworkPassphrase: string;
  stellarNetwork: string;
  marketWasmHash: string | undefined;
  /** `contracts/perpetual` — see `polaris-contracts/README.md`'s "The perpetual contract". */
  perpetualWasmHash: string | undefined;
  lazerContract: string | undefined;
  nativeXlmSac: string | undefined;
  smartWalletFactoryContract: string | undefined;
  smartWalletWasmHash: string | undefined;
  treasuryAddress: string | undefined;
  xlmUsdFeedId: number;
  marketsDbFile: string;
  friendbotUrl: string;
  faucetAmountStroops: string;
  faucetMaxPerHour: number;
  /** IP-keyed limit on POST /wallets/deploy — mitigates, doesn't close, the known unauthenticated-endpoint gap (see WalletDeployRateLimiter). */
  walletDeployMaxPerHour: number;
  settleFreshnessWindowSecs: number;
  emailWalletEncKeyHex: string;
  sessionJwtSecret: string;
  sessionTtlSecs: number;
  emailProvider: string;
  resendApiKey: string | undefined;
  emailFrom: string;
  emailCodeTtlSecs: number;
  emailCodeMaxAttempts: number;
  emailCodeResendCooldownSecs: number;
  /** Only used to fill in a WebAuthn-shaped `client_data_json`/`rpIdHash` for custodial signatures — never validated on-chain (see `email-wallet-signer.ts`), so these don't need to match the frontend exactly. */
  emailWalletRpId: string;
  emailWalletOrigin: string;
  vaultContract: string | undefined;
  /**
   * Feeds `MarketFactoryService` creates markets for. Not auto-discovered
   * from Pyth's catalog: `@pythnetwork/pyth-lazer-sdk` *does* ship a
   * `getSymbols()` metadata lookup (correcting an earlier, incomplete read
   * of this SDK — it exists, confirmed straight from
   * `dist/esm/client.mjs`), but it's an authenticated call gated on
   * `PYTH_LAZER_TOKEN`, the same optional/paid credential settlement itself
   * degrades gracefully without — not something worth hard-depending on for
   * "what feeds exist." So this stays "no human clicks a button," not
   * "automatically finds every tradeable asset": a maintained list, not a
   * live discovery feed. See `polaris-contracts/README.md`'s vault section
   * for how this fits into market creation.
   *
   * `feedId` is the small-integer Pyth Lazer id (`XLM_USD_FEED_ID`'s scheme
   * — what `settle()` subscribes to and what gets stored per market).
   * `hermesFeedId` is the *separate* 32-byte-hex id Pyth's Hermes HTTP API
   * uses (same distinction `PriceController` already documents) — read once
   * per catalog entry to pick a fresh strike price at creation time
   * (`MarketFactoryService`) and, independently, as a settlement-time
   * cross-check against the Lazer-signed price (`MarketService.trySettle`,
   * `settleOracleToleranceBps` below) — the *strike*-price lookup has no
   * on-chain equivalent to compare against; the *settlement* one does, via
   * `OracleService.waitForUpdate`'s `parsed: true` decode of the same
   * `leEcdsa` message.
   */
  feedCatalog: { feedId: number; hermesFeedId: string; symbol: string }[];
  /**
   * How far apart (in bps) the Lazer-signed settlement price and Hermes'
   * independently-fetched current price are allowed to be before
   * `trySettle` refuses to trust the payload and falls back to `cancel`
   * instead — defense in depth on top of the on-chain signature
   * verification, not a replacement for it. Deliberately loose (150 = 1.5%
   * default): both ultimately source from Pyth, so this is catching a gross
   * divergence (a stale/wrong feed, a parse bug), not adjudicating normal
   * cross-path noise between two aggregations of the same publisher
   * network — a tight tolerance would turn a safety net into a new way to
   * needlessly stall a healthy settlement.
   */
  settleOracleToleranceBps: number;
  /**
   * `Market.reflector` — the on-chain second-oracle enforcement `settle()`
   * itself now performs (see `polaris-contracts/README.md`'s "On-chain
   * second-oracle: Reflector Network"), distinct from
   * `settleOracleToleranceBps` above (that's the *earlier, off-chain*
   * Lazer-vs-Hermes advisory check, still separately in place). These four
   * become `initialize`'s 12th parameter for every newly-deployed market.
   */
  reflectorContract: string | undefined;
  reflectorAsset: string;
  reflectorMaxStalenessSecs: string;
  reflectorToleranceBps: number;
  marketFactoryIntervalSecs: number;
  marketFactoryExpirySecs: number;
  marketFactoryGracePeriodSecs: number;
  marketFactoryBaseFeeBps: number;
  /** How often `OddsSnapshotService` records each open market's odds — the resolution of the frontend's "Chg" column. */
  oddsSnapshotIntervalSecs: number;
  /** The lookback window `GET /markets/:id/price`'s `yesBpsChange` is computed against — see `OddsSnapshotRepository.closestBefore`. */
  oddsChangeWindowSecs: number;
  marketFactoryMinFeeBps: number;
  marketFactoryInitialLiquidityStroops: string;
  /**
   * `contracts/perpetual`'s `price_oracle` bundle requires *both* the
   * Reflector and RedStone legs whenever it's configured at all (see
   * `polaris-contracts/README.md`'s "A third oracle: RedStone") —
   * RedStone has no testnet deployment, so `mockRedstoneContract` points
   * at `polaris-mock-redstone` (also see that README) as its stand-in.
   * `perpetualPriceOracle` stays `undefined` (and every perpetual this
   * backend deploys keeps `price_oracle: None`, as before) unless *all*
   * of `lazerContract`/`reflectorContract`/`mockRedstoneContract` are
   * configured — no half-wired bundle gets passed to `initialize`.
   */
  mockRedstoneContract: string | undefined;
  redstoneMaxStalenessSecs: string;
  redstoneToleranceBps: number;
}

import { randomBytes } from 'node:crypto';

/**
 * Dev-only fallback so the process can boot without every secret set —
 * generated fresh each boot, which means any data encrypted/signed with it
 * (custodial private keys, session tokens) becomes unrecoverable/invalid
 * across a restart. Loud on purpose: this must never be what production
 * actually runs on.
 */
function devFallbackSecret(envVar: string, byteLength: number): string {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  // eslint-disable-next-line no-console
  console.warn(
    `[config] ${envVar} not set — generating a random one for this process only. ` +
      `Custodial email wallets will be unrecoverable after a restart until this is set. Do not run production like this.`,
  );
  return randomBytes(byteLength).toString('hex');
}

/**
 * Every numeric setting used to be `Number(process.env.X ?? default)`,
 * which silently turns a typo'd value (`"five"`, `"300s"`) into `NaN`.
 * `NaN` then flows into safety checks with surprising results —
 * `recent.length >= NaN` is always false (rate limiters stop limiting),
 * `setInterval(fn, NaN)` fires roughly every 1ms — with no boot-time
 * signal. This throws instead, naming the bad variable, and optionally
 * enforces a range/integer constraint.
 */
function requireNumber(
  name: string,
  defaultValue: number,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? defaultValue : Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`[config] ${name} must be a valid number, got ${JSON.stringify(raw)}`);
  }
  if (opts.integer && !Number.isInteger(value)) {
    throw new Error(`[config] ${name} must be an integer, got ${raw}`);
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new Error(`[config] ${name} must be >= ${opts.min}, got ${value}`);
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new Error(`[config] ${name} must be <= ${opts.max}, got ${value}`);
  }
  return value;
}

const HEX_32_BYTES = /^[0-9a-fA-F]{64}$/;

/**
 * `emailWalletEncKeyHex` is passed straight into
 * `Buffer.from(keyHex, 'hex')` in `email-crypto.ts`, which silently
 * truncates at the first non-hex character rather than throwing — a
 * mis-pasted key would otherwise only surface as an opaque
 * `Invalid key length` error on the first email login, long after
 * deploy succeeded. Require exactly 64 hex chars (32 bytes) up front.
 */
function requireHex32Bytes(name: string, value: string): string {
  if (!HEX_32_BYTES.test(value)) {
    throw new Error(`[config] ${name} must be 64 hex characters (32 bytes), got length ${value.length}`);
  }
  return value;
}

// XLM/USD's real Hermes registry id — confirmed live against
// `hermes.pyth.network`'s own `/v2/price_feeds?query=XLM` lookup and a real
// `/v2/updates/price/latest` read (not copied from memory/docs and hoped
// correct), unlike XLM_USD_FEED_ID's Lazer id above, which really is an
// unverified testnet placeholder since Lazer has no equivalent public
// lookup. Still: this only decides the *strike price* of an auto-created
// market, not settlement — a wrong id here fails the Hermes lookup loudly
// per-feed (see MarketFactoryService.run), it doesn't misprice anything
// silently.
const DEFAULT_FEED_CATALOG: { feedId: number; hermesFeedId: string; symbol: string }[] = [
  { feedId: 100, hermesFeedId: '0xb7a8eba68a997cd0210c2e1e4ee811ad2d174b3611c22d9ebf16f4cb7e9ba850', symbol: 'XLM/USD' },
];

/** Parses `FEED_CATALOG` (a JSON array of `{feedId, hermesFeedId, symbol}`) — falls back to the single feed this build has always used rather than throwing, since a malformed env var shouldn't stop the whole process from booting. */
function parseFeedCatalog(raw: string | undefined): { feedId: number; hermesFeedId: string; symbol: string }[] {
  if (!raw) return DEFAULT_FEED_CATALOG;
  try {
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (f) => typeof f?.feedId === 'number' && typeof f?.hermesFeedId === 'string' && typeof f?.symbol === 'string',
      )
    ) {
      return parsed;
    }
  } catch {
    // fall through to the warning + default below
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[config] FEED_CATALOG is set but not a valid JSON array of {feedId, hermesFeedId, symbol} — using the default.`,
  );
  return DEFAULT_FEED_CATALOG;
}

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Catches the "deploys fine, funds wallets fine, then every email trade
 * fails with OriginMismatch" footgun: `emailWalletOrigin` must exactly
 * match the smart-wallet factory's pinned origin on-chain, and
 * `emailWalletEncKeyHex`/`sessionJwtSecret` must not be left on their
 * dev-only random fallback. Dev/test behavior (warnings only) is
 * unchanged — this only throws when NODE_ENV=production.
 */
function assertProductionReady(cfg: {
  emailWalletOrigin: string;
  corsOrigins: string[];
  emailWalletEncKeyWasFallback: boolean;
  sessionJwtSecretWasFallback: boolean;
}): void {
  if (!isProduction) return;
  const problems: string[] = [];
  if (cfg.emailWalletOrigin.startsWith('http://localhost')) {
    problems.push('EMAIL_WALLET_ORIGIN is still set to a localhost default');
  }
  if (cfg.emailWalletEncKeyWasFallback) {
    problems.push('EMAIL_WALLET_ENC_KEY is unset — production must not run on a random per-boot key');
  }
  if (cfg.sessionJwtSecretWasFallback) {
    problems.push('SESSION_JWT_SECRET is unset — production must not run on a random per-boot secret');
  }
  if (cfg.corsOrigins.length === 0) {
    problems.push('CORS_ORIGINS is empty');
  }
  if (problems.length > 0) {
    throw new Error(`[config] refusing to boot in production:\n${problems.map((p) => ` - ${p}`).join('\n')}`);
  }
}

export default (): AppConfig => {
  const emailWalletEncKeyWasFallback = !process.env.EMAIL_WALLET_ENC_KEY;
  const sessionJwtSecretWasFallback = !process.env.SESSION_JWT_SECRET;
  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const emailWalletOrigin = process.env.EMAIL_WALLET_ORIGIN ?? 'http://localhost:3000';

  assertProductionReady({
    emailWalletOrigin,
    corsOrigins,
    emailWalletEncKeyWasFallback,
    sessionJwtSecretWasFallback,
  });

  return {
  port: requireNumber('PORT', 3000, { min: 1, max: 65535, integer: true }),
  oracleSecretKey: process.env.ORACLE_SECRET_KEY ?? '',
  deployerSecretKey: process.env.DEPLOYER_SECRET_KEY,
  adminApiKey: process.env.ADMIN_API_KEY ?? '',
  pythLazerToken: process.env.PYTH_LAZER_TOKEN,
  pythLazerWsUrl: process.env.PYTH_LAZER_WS_URL ?? 'wss://pyth-lazer.dourolabs.app/v1/stream',
  pythHermesUrl: process.env.PYTH_HERMES_URL ?? 'https://hermes.pyth.network',
  corsOrigins,
  stellarRpcUrl: process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org',
  stellarNetworkPassphrase:
    process.env.STELLAR_NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015',
  stellarNetwork: process.env.STELLAR_NETWORK ?? 'testnet',
  marketWasmHash: process.env.MARKET_WASM_HASH,
  perpetualWasmHash: process.env.PERPETUAL_WASM_HASH,
  lazerContract: process.env.LAZER_CONTRACT,
  nativeXlmSac: process.env.NATIVE_XLM_SAC,
  smartWalletFactoryContract: process.env.SMART_WALLET_FACTORY_CONTRACT,
  smartWalletWasmHash: process.env.SMART_WALLET_WASM_HASH,
  treasuryAddress: process.env.TREASURY_ADDRESS,
  // Placeholder testnet feed id — production must use Pyth's real
  // registered Lazer feed id for XLM/USD (see contracts README).
  xlmUsdFeedId: requireNumber('XLM_USD_FEED_ID', 100, { integer: true, min: 0 }),
  marketsDbFile: process.env.MARKETS_DB_FILE ?? './data/markets.db',
  friendbotUrl: process.env.FRIENDBOT_URL ?? 'https://friendbot.stellar.org',
  faucetAmountStroops: process.env.FAUCET_AMOUNT_STROOPS ?? '5000000000', // 500 XLM
  faucetMaxPerHour: requireNumber('FAUCET_MAX_PER_HOUR', 3, { min: 0 }),
  walletDeployMaxPerHour: requireNumber('WALLET_DEPLOY_MAX_PER_HOUR', 5, { min: 0 }),
  settleFreshnessWindowSecs: requireNumber('SETTLE_FRESHNESS_WINDOW_SECS', 300, { min: 0 }),
  // 32 bytes hex = AES-256-GCM key, encrypting custodial private keys at rest.
  emailWalletEncKeyHex: process.env.EMAIL_WALLET_ENC_KEY
    ? requireHex32Bytes('EMAIL_WALLET_ENC_KEY', process.env.EMAIL_WALLET_ENC_KEY)
    : devFallbackSecret('EMAIL_WALLET_ENC_KEY', 32),
  sessionJwtSecret: devFallbackSecret('SESSION_JWT_SECRET', 32),
  sessionTtlSecs: requireNumber('SESSION_TTL_SECS', 60 * 60 * 24 * 30, { min: 1 }), // 30 days
  // 'console' (default, logs the code — no real delivery) or 'resend'.
  emailProvider: process.env.EMAIL_PROVIDER ?? 'console',
  resendApiKey: process.env.RESEND_API_KEY,
  emailFrom: process.env.EMAIL_FROM ?? 'Polaris <login@polaris.app>',
  emailCodeTtlSecs: requireNumber('EMAIL_CODE_TTL_SECS', 600, { min: 1 }), // 10 minutes
  emailCodeMaxAttempts: requireNumber('EMAIL_CODE_MAX_ATTEMPTS', 5, { min: 1, integer: true }),
  emailCodeResendCooldownSecs: requireNumber('EMAIL_CODE_RESEND_COOLDOWN_SECS', 60, { min: 0 }),
  emailWalletRpId: process.env.EMAIL_WALLET_RP_ID ?? 'localhost',
  emailWalletOrigin,
  vaultContract: process.env.VAULT_CONTRACT,
  feedCatalog: parseFeedCatalog(process.env.FEED_CATALOG),
  settleOracleToleranceBps: requireNumber('SETTLE_ORACLE_TOLERANCE_BPS', 150, { min: 0 }),
  reflectorContract: process.env.REFLECTOR_CONTRACT,
  reflectorAsset: process.env.REFLECTOR_ASSET ?? 'XLM',
  // Comfortably above the real Reflector testnet oracle's own resolution()
  // (300s, confirmed live) — initialize() itself also validates this
  // on-chain against whatever the configured instance actually reports.
  reflectorMaxStalenessSecs: process.env.REFLECTOR_MAX_STALENESS_SECS ?? '600',
  reflectorToleranceBps: requireNumber('REFLECTOR_TOLERANCE_BPS', 150, { min: 0 }),
  // 5 min: this is now a safety net for a missed 'finalized' event (see
  // MarketFactoryService), not the primary creation trigger — the common
  // case is a cheap hasOpenMarket check with no network calls, and staying
  // well under marketFactoryGracePeriodSecs (1h default) bounds how long a
  // crash right after expiry could leave a feed dark.
  marketFactoryIntervalSecs: requireNumber('MARKET_FACTORY_INTERVAL_SECS', 5 * 60, { min: 1 }),
  oddsSnapshotIntervalSecs: requireNumber('ODDS_SNAPSHOT_INTERVAL_SECS', 5 * 60, { min: 1 }),
  oddsChangeWindowSecs: requireNumber('ODDS_CHANGE_WINDOW_SECS', 60 * 60, { min: 1 }),
  marketFactoryExpirySecs: requireNumber('MARKET_FACTORY_EXPIRY_SECS', 24 * 60 * 60, { min: 1 }), // 24 hours
  marketFactoryGracePeriodSecs: requireNumber('MARKET_FACTORY_GRACE_PERIOD_SECS', 3600, { min: 0 }),
  marketFactoryBaseFeeBps: requireNumber('MARKET_FACTORY_BASE_FEE_BPS', 100, { min: 0 }),
  marketFactoryMinFeeBps: requireNumber('MARKET_FACTORY_MIN_FEE_BPS', 20, { min: 0 }),
  marketFactoryInitialLiquidityStroops: process.env.MARKET_FACTORY_INITIAL_LIQUIDITY_STROOPS ?? '1000000000', // 100 XLM
  mockRedstoneContract: process.env.MOCK_REDSTONE_CONTRACT,
  redstoneMaxStalenessSecs: process.env.REDSTONE_MAX_STALENESS_SECS ?? '600',
  redstoneToleranceBps: requireNumber('REDSTONE_TOLERANCE_BPS', 150, { min: 0 }),
  };
};
