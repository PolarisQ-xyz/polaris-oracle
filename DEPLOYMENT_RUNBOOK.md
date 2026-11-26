# Fresh-Environment Deployment Runbook

This document enumerates **all Fly.io secrets** required to run a fresh Polaris Oracle deployment. Ensure each secret is set before executing `flyctl deploy`.

## Required Secrets (19 total)

| Secret | Description |
|--------|-------------|
| `ORACLE_SECRET_KEY` | Stellar secret key; pays transaction fees. Required for all operations. |
| `ADMIN_API_KEY` | Shared secret protecting admin endpoints. |
| `DEPLOYER_SECRET_KEY` | (Optional) Separate funded key for market deployment. Falls back to `ORACLE_SECRET_KEY` if unset. |
| `LAZER_CONTRACT` | Deployed `polaris-lazer-stellar` verifier contract ID. |
| `NATIVE_XLM_SAC` | Native XLM Stellar Asset Contract ID used as collateral. |
| `SMART_WALLET_FACTORY_CONTRACT` | Deployed & initialized `polaris-smart-wallet-factory` contract ID. |
| `SMART_WALLET_WASM_HASH` | SHA‑256 hash of `polaris_smart_wallet.wasm` (used during factory initialization). |
| `VAULT_CONTRACT` | Deployed & initialized `polaris-vault` contract ID (capital‑efficiency vault). |
| `TREASURY_ADDRESS` | Protocol fee / AMM seed‑liquidity recipient address. |
| `FEED_CATALOG` | JSON array of `{feedId, hermesFeedId, symbol}` for market creation. Example: `[{"feedId":100,"hermesFeedId":"0xb7a8...","symbol":"XLM/USD"}]`. |
| `MARKET_WASM_HASH` | SHA‑256 hash of `polaris_market.wasm`. |
| `PERPETUAL_WASM_HASH` | SHA‑256 hash of `polaris_perpetual.wasm`. |
| `MOCK_REDSTONE_CONTRACT` | (Optional) Mock RedStone contract ID for perpetual markets. |
| `REFLECTOR_CONTRACT` | Deployed Reflector oracle contract ID (no safe default). |
| `REFLECTOR_ASSET` | Asset symbol used by the Reflector oracle, e.g., `XLM`. |
| `REFLECTOR_MAX_STALENESS_SECS` | Maximum staleness allowed for Reflector oracle data. |
| `REFLECTOR_TOLERANCE_BPS` | Tolerance (bps) for Reflector price deviation. |
| `PYTH_LAZER_TOKEN` | Token for accessing Pyth Lazer API (required for Lazer‑verified settles). |
| `EMAIL_WALLET_ENC_KEY` | 32‑byte hex AES‑256‑GCM key encrypting custodial email wallets. |
| `SESSION_JWT_SECRET` | 32‑byte hex secret for signing JWT session tokens. |

## Optional Secrets (with defaults)

| Secret | Default / Note |
|--------|----------------|
| `PYTH_LAZER_WS_URL` | `wss://pyth-lazer.dourolabs.app/v1/stream` |
| `PYTH_HERMES_URL` | `https://hermes.pyth.network` |
| `CORS_ORIGINS` | Comma‑separated list; defaults to empty (no CORS). |
| `STELLAR_RPC_URL` | `https://soroban-testnet.stellar.org` |
| `STELLAR_NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` |
| `STELLAR_NETWORK` | `testnet` |
| `EMAIL_PROVIDER` | `console` (use `resend` for real email delivery) |
| `RESEND_API_KEY` | Required only if `EMAIL_PROVIDER=resend`. |
| `EMAIL_FROM` | `Polaris <login@polaris.app>` |
| `SETTLE_ORACLE_TOLERANCE_BPS` | `150` |
| `WALLET_DEPLOY_MAX_PER_HOUR` | `5` |
| `FAUCET_MAX_PER_HOUR` | `3` |
| `FAUCET_AMOUNT_STROOPS` | `5000000000` (500 XLM) |

## Deployment Steps
1. Populate a `.env` file (or Fly secrets) with **all required secrets** above.
2. Verify secret presence with `fly secrets list`.
3. Deploy using:
   ```bash
   flyctl deploy
   ```
4. After deployment, confirm the app is healthy and that admin endpoints require the `ADMIN_API_KEY`.

Keep this runbook version‑controlled alongside the repository to ensure new contributors have a single source of truth for deployment configuration.
