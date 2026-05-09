# Safety and security posture

This repo is intentionally a research and paper-trading system. This document states the safety boundary, secret-handling rules, operational guardrails, and what must be true before any future live-trading work is considered.

## Current safety boundary

V1 is dry-run / paper trading only.

```text
DRY_RUN=true
```

The bot may:

- read public wallet activity;
- read public token market data;
- record local signals;
- open simulated paper positions;
- close simulated paper positions;
- send alerts;
- mutate local watchlist JSON when explicitly commanded or configured maintenance runs.

The bot must not:

- store seed phrases;
- store private keys;
- sign Solana transactions;
- submit swaps/orders;
- auto-buy tokens;
- auto-sell tokens;
- infer that a paper exit means a live exit happened;
- expose credentials in docs, logs, dashboard, reports, or assistant summaries.

## Threat model

The practical risks for this repo are:

1. Credential leakage through `.env`, logs, docs, screenshots, or chat transcripts.
2. Accidental LAN dashboard exposure without auth.
3. API budget exhaustion from aggressive polling/discovery.
4. Watchlist contamination from noisy public wallets.
5. Misinterpreting paper-trading results as live-trading readiness.
6. Future feature creep into live execution without security design.
7. Operational scripts mutating wallet state too broadly.
8. SQLite/data/report files leaking strategy research if shared publicly.

## Secrets

Potential secrets and sensitive values:

| Value | Where it belongs | Never put it in |
| --- | --- | --- |
| `HELIUS_API_KEY` | `.env` | README, docs, git, logs, screenshots |
| `SOLANA_RPC_URL` with key | `.env` | docs/git/logs if real key embedded |
| `HELIUS_WS_URL` with key | `.env` | docs/git/logs if real key embedded |
| `CIELO_API_KEY` | `.env` | docs/git/logs |
| `TELEGRAM_BOT_TOKEN` | `.env` | docs/git/logs |
| `TELEGRAM_CHAT_ID` | `.env` or private ops notes | public docs if routing privacy matters |
| `DASHBOARD_AUTH_TOKEN` | `.env` | URL query strings, docs, logs |
| `GROK_API_KEY` | `.env` if future CT scanner is enabled | docs/git/logs |

`.env.example` should contain placeholders only.

Before sharing command output or docs, scan for:

```text
api-key=
API_KEY=
TOKEN=
AUTH_TOKEN=
BOT_TOKEN=
Bearer
x-dashboard-token
```

Use `[REDACTED]` for real secrets.

## Git hygiene

Do commit:

- source code;
- tests;
- docs;
- `.env.example` placeholders;
- reviewed watchlist changes when intentional.

Do not commit:

- `.env`;
- local SQLite DB;
- DB sidecars;
- generated reports containing sensitive research unless intentionally sanitized;
- dashboard tokens;
- API responses containing credentials;
- logs with secrets.

Pre-commit inspection:

```bash
git status --short
git diff --stat
git diff -- README.md docs .env.example package.json src tests
```

If watchlist changed:

```bash
git diff -- config/watched-wallets.json
```

If `.env` appears in git status, stop and fix `.gitignore`/index state.

## Dashboard security

Dashboard rules:

- Read-only only.
- Local SQLite/watchlist data only.
- No external API calls from dashboard.
- No watchlist mutation endpoints.
- No secret display.
- Auth required for non-loopback binds unless explicitly insecure.

Config:

```text
DASHBOARD_AUTH_TOKEN=
DASHBOARD_INSECURE=false
```

Safe default:

```bash
npm run dashboard -- --host 127.0.0.1 --port 8788
```

LAN mode with token:

```bash
DASHBOARD_AUTH_TOKEN=[REDACTED] npm run dashboard -- --host 0.0.0.0 --port 8788
```

Explicit trusted-LAN insecure mode:

```text
DASHBOARD_INSECURE=true
```

Only use insecure LAN mode when the network is trusted and the risk is accepted.

## API budget safety

External API calls can run up provider bills or exhaust free-tier credits.

Budget controls:

```text
API_BUDGET_PROVIDER=helius
API_BUDGET_SOFT_DAILY_CREDITS=80000
API_BUDGET_HARD_DAILY_CREDITS=95000
API_BUDGET_TRACKING_ENABLED=true
```

Modes:

- normal: under soft budget;
- conserve: soft budget exceeded; candidate scans pause first;
- emergency: hard budget exceeded; requests blocked/refused.

Operator rules:

- Treat local budget as an estimate.
- Check provider dashboard for exact billing/usage.
- Increase scan intervals or reduce limits before raising hard budget.
- Candidate-tier wallets should be first to slow/disable.
- Discovery/vetting commands can be API-expensive; run intentionally.

## Watchlist mutation safety

The active watchlist is strategy state.

Before mutating:

```bash
git status --short
git diff -- config/watched-wallets.json
```

Safe mutation paths:

```bash
npm run add-wallet -- <address> <label> <trust>
npm run vet-wallets -- config/cielo-wallet-candidates.json --apply --signatures=40
npm run discover-wallets -- --apply --signatures=40
npm run wallet-maintenance
```

After mutating:

```bash
npm run wallets
git diff -- config/watched-wallets.json
```

Risk controls:

- Auto-added candidates start low-trust and candidate-tier.
- Probation wallets should not be bulk-included unless intentionally increasing exploration.
- Rotation should preserve backups.
- Archive stale/losing/noisy wallets rather than simply expanding the set forever.

## Signal safety

A signal means multiple watched wallets bought the same token within the configured window. It does not mean:

- the token is safe;
- liquidity is sufficient;
- a real wallet can fill at the paper price;
- the wallets are non-colluding;
- the opportunity is still live.

Token scoring adds hard gates and warnings, but it is still heuristic.

Failure reasons should be preserved, not hidden. They explain why the bot skipped a token.

## Paper-trading safety

Paper trading is a model. It is useful because it records assumptions, but it is not execution proof.

Important differences from live trading:

- no mempool/front-run effects;
- no failed transaction cost;
- no wallet balance/rent/priority fee constraints;
- approximate slippage/impact only;
- provider price lag possible;
- no actual fill confirmation;
- no real exit execution.

Paper PnL should be used to rank signal quality and wallet usefulness, not to claim live profitability.

## Stop/take-profit/trailing rules

Default paper exits:

```text
STOP_LOSS_PERCENT=-40
TAKE_PROFIT_1_MULTIPLE=2
TAKE_PROFIT_2_MULTIPLE=3
TAKE_PROFIT_3_MULTIPLE=5
TRAILING_STOP_ACTIVATION_MULTIPLE=1.5
TRAILING_STOP_DRAWDOWN_PERCENT=30
```

These are simulated rules. They do not protect capital unless a separate live system exists, which this repo does not have.

## systemd hardening

The provided user services include practical hardening:

- `NoNewPrivileges=true`
- `PrivateTmp=true`
- `ProtectSystem=full`
- constrained `ReadWritePaths`

Bot service write access:

```text
/home/thetopham/memecoin-alpha-bot/data
/home/thetopham/memecoin-alpha-bot/config
```

Dashboard service write access:

```text
/home/thetopham/memecoin-alpha-bot/data
```

These settings reduce accidental filesystem damage but are not a sandbox for malicious code.

## Hermes automation safety

Hermes may operate the repo, but recurring jobs should be bounded.

Hermes cron rules:

- prompts must be self-contained;
- jobs should not recursively create jobs;
- health checks should stay silent on OK;
- scripts must not print secrets;
- watchlist-changing jobs should report changes and backups;
- no live trading actions;
- no private-key paths;
- no automatic API-key rotation;
- no threshold/risk changes without approval.

## Incident runbooks

### Secret accidentally printed

1. Stop sharing the transcript/log.
2. Rotate the affected secret at the provider.
3. Update `.env` with the new value.
4. Restart affected services.
5. Search repo/logs for the leaked value.
6. Remove/redact committed leaks from git history if needed.

### Dashboard exposed without auth

1. Stop dashboard service or bind to localhost.
2. Set `DASHBOARD_AUTH_TOKEN` or remove `DASHBOARD_INSECURE=true`.
3. Restart dashboard service.
4. Check recent access logs if available.
5. Treat exposed strategy data as potentially visible on LAN.

### API budget runaway

1. Stop or pause scanner if needed:

```bash
systemctl --user stop memecoin-alpha-bot.service
```

2. Check provider dashboard.
3. Inspect local `api_usage` and logs.
4. Increase scan intervals / lower limits / disable candidate scans.
5. Restart service only after budget is safe.

### Bad watchlist auto-add

1. Stop wallet maintenance if it is actively running.
2. Inspect backup in `config/.wallet-backups/`.
3. Review `git diff -- config/watched-wallets.json`.
4. Restore manually from backup or git if needed.
5. Tighten candidate thresholds/batch limits.
6. Re-run `npm run wallets`.

### Paper results look too good

1. Inspect fill assumptions and liquidity confidence.
2. Check whether wins cluster around one wallet/token/source.
3. Check signal-to-fill latency.
4. Verify market data was available at entry/exit times.
5. Do not infer live-readiness without independent validation.

## Requirements before any future live-trading branch

A future live-trading effort must be explicit and separate. Minimum design requirements:

1. Burner wallet only.
2. Private key storage design and access boundary.
3. No seed phrases in `.env` if avoidable; prefer delegated signer or encrypted local store.
4. Max position size.
5. Max daily loss.
6. Max open positions.
7. Max slippage.
8. DEX/router choice and failure handling.
9. Dry-run/live split that cannot be toggled accidentally.
10. Kill switch.
11. Manual approval mode.
12. Full audit log.
13. Alerting on every live action.
14. Integration tests against a simulator/devnet where possible.
15. Rollback/disable plan.
16. Security review of dependencies and service permissions.

Until that exists, live trading is out of scope.

## Safe language for reports

Use:

- “paper trade”
- “simulated entry”
- “estimated fill”
- “paper PnL”
- “would have exited under rules”
- “signal passed/failed scoring”

Avoid:

- “bought” unless referring to tracked wallets' on-chain buys;
- “we entered” without saying paper/simulated;
- “profit” without saying paper;
- “safe token”;
- “guaranteed alpha”;
- “ready for live trading.”

## Final checklist for risky changes

Before merging any change touching integrations, scoring, wallet mutation, dashboard auth, or future execution:

```bash
git status --short
npm run lint
npm test
npm run build
git diff --stat
```

Then answer:

1. Does this preserve `DRY_RUN=true` as the default?
2. Could this print or commit a secret?
3. Could this increase API spend unexpectedly?
4. Could this mutate the watchlist unexpectedly?
5. Could this expose dashboard data on LAN/WAN?
6. Could this make paper results look like live results?
7. Did docs and tests change with behavior?

If any answer is uncertain, stop and review before deploying.
