# Incident Response Runbook for Polaris Oracle

**Purpose**: Provide a concise, step‑by‑step guide for the on‑call maintainer to follow when an alert fires.

## 1. Verify the Alert
- Open the monitoring dashboard (e.g., Grafana/Prometheus) and locate the alert details.
- Confirm the alert state is **Firing** and note the affected component (e.g., `market-service`, `oracle-service`).
- Check the alert description for any suggested severity or immediate actions.

## 2. Check System Health
- **API endpoints**: Run `curl https://polaris-oracle-api.fly.dev/health` (or the appropriate health endpoint) to ensure the service is reachable.
- **Database**: Verify the SQLite WAL file is not locked and recent migrations have applied (`ls -l data/*.db`).
- **External services**: Confirm connectivity to Stellar RPC, Pyth Lazer, and Reflector Network via their status pages.

## 3. Review Recent Logs
```sh
docker logs $(docker ps -q --filter "ancestor=polaris-oracle") --tail 100
```
- Look for error stacks related to the alerted component.
- Note timestamps and any repeated patterns.

## 4. Identify the Root Cause
- If the alert is about **settlement failures**, check:
  - `src/market/market.service.ts` timers for recent failures.
  - Oracle availability (`src/market/oracle.service.ts`).
- For **price feed issues**, inspect `src/market/pyth-price.ts` and the WebSocket connection logs.
- For **admin API errors**, verify the `ADMIN_API_KEY` env var and the `AdminGuard` behavior.

## 5. Mitigation Steps
| Issue Type | Immediate Action |
|------------|------------------|
| Settlement failure | Manually trigger settlement via `POST /markets/:id/settle` after confirming price availability. |
| Oracle outage | Switch to fallback `settle_via_reflector` by ensuring `PYTH_LAZER_TOKEN` is unset or expired; no code change required. |
| Database lock | Restart the container (`flyctl apps restart polaris-oracle`). |
| Unexpected crash | Restart the service (`flyctl apps restart polaris-oracle`) and monitor for repeat alerts. |

## 6. Post‑Incident
- Add a comment to the alert in the monitoring system with:
  - Timestamp of detection and resolution.
  - Actions taken and their outcomes.
  - Any follow‑up tasks (e.g., bug report, config change).
- If the incident exposed a code defect, create a GitHub issue with reproduction steps and link it to the runbook.
- Update this runbook if new steps are required.

## 7. Escalation
- If the issue persists after mitigation, page the secondary on‑call (see `oncall.md` in the ops repo) and open a high‑priority GitHub issue tagging `@maintainer`.

---
*This document is intentionally short to aid rapid response. It should be kept up‑to‑date as the system evolves.*