# Integrations and external services

This document explains every external integration used by the dry-run scanner, what data is fetched or sent, how failures are handled, and what safety boundaries apply.

## Integration map

| Integration | Direction | Required? | Used by | Purpose |
| --- | --- | --- | --- | --- |
| Solana RPC / Helius | outbound | yes | scanner, wallet vetting, holder analysis | wallet signatures, parsed transactions, token supply/largest accounts |
| DexScreener | outbound | yes for scoring/paper updates | token analyzer, paper trader, reports | token price, liquidity, volume, pair age, market metadata |
| pump.fun fallback | outbound via market client | optional fallback | DexScreener client | pre-graduation/bonding-curve context when DEX liquidity is unavailable |
| Cielo | outbound | optional | wallet discovery | candidate wallet sourcing and feed analysis |
| Telegram Bot API | outbound | optional | notifier | alerts for signals, paper exits, operational warnings |
| Local dashboard HTTP | inbound | optional | operator/Hermes/browser | read-only local state view |
| systemd user services | local | optional but recommended | deployment | keep scanner/dashboard running |
| Hermes cron/scripts | local + optional outbound delivery | optional | operations | watchdogs, position checks, wallet maintenance reports |

No integration should provide private keys or live order execution in v1.

## Solana RPC / Helius

### Config

```text
HELIUS_API_KEY=
SOLANA_RPC_URL=https://beta.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY
HELIUS_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY
```

`HELIUS_WS_URL` is present as config surface but the current scanner flow is polling-oriented. The core wallet tracker uses RPC calls rather than a WebSocket subscription loop.

### Used for

- `getSignaturesForAddress`
- `getParsedTransaction`
- token supply / largest token accounts for holder concentration
- wallet vetting signature samples
- Cielo apply-mode vetting

### RPC client behavior

The Solana RPC wrapper uses:

- request timeout around 15 seconds;
- max retries around 5;
- exponential/backoff behavior up to about 30 seconds;
- default pacing around 125ms between RPC requests, designed to stay below Helius free-tier 10 rps;
- optional API budget accounting hooks.

RPC failures should degrade a scan where possible instead of crashing the whole long-lived process.

### Budget accounting

RPC requests can be logged to `api_usage` and interpreted by `apiBudget.ts`.

Budget modes:

| Mode | Meaning | Behavior |
| --- | --- | --- |
| `normal` | Below soft daily credit limit. | Normal scanning. |
| `conserve` | At/above soft daily credit limit. | Candidate tier scans are paused/refused first. |
| `emergency` | At/above hard daily credit limit. | Requests are blocked/refused by budget policy. |

Important limitation: local budget accounting is only what this bot logs. Provider dashboard usage is authoritative.

### Failure symptoms

| Symptom | Likely cause | Safe response |
| --- | --- | --- |
| Many 429s | Rate limit/budget pressure. | Increase scan intervals, reduce signature limits, check provider dashboard. |
| Parsed transactions missing/null | Provider lag, unsupported tx, old tx, rate limit. | Retry later; do not assume no activity. |
| Holder concentration unavailable | RPC method failure or token shape issue. | Treat as warning/null unless policy requires hard fail. |
| Scanner stalls on one wallet | Slow RPC/retries. | Check logs and budget; do not delete wallet blindly. |

## DexScreener

### Used for

DexScreener provides the main market snapshot used by scoring and paper monitoring:

- token symbol/name;
- pair address and DEX id;
- price USD;
- liquidity USD;
- volume windows;
- price-change windows;
- pair creation/age;
- market URL;
- market stage where inferable.

### Scoring dependency

`tokenAnalyzer.ts` uses market data to evaluate:

- liquidity;
- volume;
- holder concentration;
- pair age;
- composite score;
- warnings/fail reasons.

If market data is unavailable, signals are queued for retry rather than immediately treated as durable failures.

### Paper-trading dependency

`paperTrader.ts` uses market snapshots to:

- open paper trades at simulated fill prices;
- update open paper trades;
- trigger stop-loss / take-profit / trailing-stop / tracked-wallet-sell exits.

### Liquidity caveat

For pre-graduation pump.fun tokens, DEX liquidity may be zero or unavailable even when token activity exists. Docs/reporting should distinguish:

- `DEX liquidity unavailable`
- `DEX liquidity unavailable / likely pre-graduation`
- `DEX liquidity unavailable / no usable pool`

Do not treat all zero liquidity as the same condition.

### Failure symptoms

| Symptom | Likely cause | Safe response |
| --- | --- | --- |
| Token not found | Very new token or provider lag. | Retry through signal retry queue. |
| Liquidity zero | Pre-graduation or no usable pool. | Do not open unless scoring policy permits. |
| Price unavailable | Provider missing pair data. | Skip/queue; do not fabricate price. |
| Stale pair data | Provider lag. | Report timestamp/context; refresh later. |

## pump.fun fallback

The market client has fallback behavior to better understand pump.fun style tokens when standard DEX pair liquidity is unavailable.

Purpose:

- classify market stage;
- avoid misleading “zero liquidity” reports;
- preserve useful warning context for bonding-curve tokens.

Safety boundary:

- fallback data is still read-only;
- it does not add buy/sell execution;
- scoring should stay conservative when liquidity/fill confidence is weak.

## Cielo

### Config

```text
CIELO_API_KEY=
CIELO_API_BASE_URL=https://feed-api.cielo.finance
CIELO_APP_BASE_URL=https://app.cielo.finance
CIELO_CANDIDATE_PATH=./config/cielo-wallet-candidates.json
CIELO_DISCOVERY_REPORT_PATH=./data/cielo-wallet-discovery-report.json
CIELO_MIN_PNL_USD=500
CIELO_MIN_ROI_PERCENT=50
CIELO_MIN_WINRATE_PERCENT=45
CIELO_MAX_LAST_ACTIVE_HOURS=48
CIELO_MAX_CANDIDATES=60
CIELO_DISCOVERY_PAGES=2
CIELO_FEED_MIN_USD=25
CIELO_FEED_LOOKBACK_HOURS=24
CIELO_VETTING_SIGNATURE_LIMIT=40
```

### Used for

Wallet discovery, not trade execution.

Sources include:

- Wallet Discovery app data;
- API wallet tags;
- public lists;
- recent feed activity;
- trending/pulse token flow.

### API key behavior

- App/public surfaces may produce candidates without `CIELO_API_KEY` depending on endpoint availability.
- API-backed sources are skipped when key is absent.
- Reports should say key configured/missing without revealing the key.

### Output files

```text
config/cielo-wallet-candidates.json
data/cielo-wallet-discovery-report.json
data/cielo-wallet-vetting-report.json
```

### Safety boundary

- Discovery alone writes candidate/report files, not active watchlist mutations.
- `--apply` is required to vet and add wallets to `config/watched-wallets.json`.
- `--include-probation` increases noise and should be deliberate.
- No Cielo workflow executes trades.

See `docs/wallet-sourcing.md` for details.

## Telegram alerts

### Config

```text
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

### Used for

The notifier sends alert text via Telegram Bot API when configured.

If token/chat id is missing, alerts are printed to logs with an `[ALERT]` prefix.

### Behavior

- outbound only;
- uses rate limiting around 1 second between sends;
- timeout around 10 seconds;
- retries around 3;
- failures should not crash the scanner.

### Secret handling

Never print or document the bot token. If verifying config, check only presence/length/metadata, not the token value.

## Dashboard HTTP service

### Commands

Development/source:

```bash
npm run dashboard -- --host 127.0.0.1 --port 8788
```

Compiled/systemd:

```bash
npm run dashboard:dist -- --host 0.0.0.0 --port 8788 --refresh 15
```

### API-neutral design

The dashboard reads only local state:

- SQLite DB;
- watchlist JSON;
- generated reports/local metadata.

It does not call:

- Helius;
- Solana RPC;
- Cielo;
- DexScreener;
- pump.fun.

Live API work stays in the bot service or explicit CLI refresh commands.

### Auth behavior

Config:

```text
DASHBOARD_AUTH_TOKEN=
DASHBOARD_INSECURE=false
```

Rules:

- If binding to non-loopback, auth is required unless `DASHBOARD_INSECURE=true`.
- Prefer header auth using `x-dashboard-token`.
- Avoid putting tokens in URLs.
- LAN exposure without auth is intentional only when `DASHBOARD_INSECURE=true` is set for a trusted network.

### Endpoints

The main dashboard serves HTML and a JSON API for local state. Exact endpoints can change, but `/api/dashboard` is the important read-only state endpoint.

### Failure symptoms

| Symptom | Likely cause | Safe response |
| --- | --- | --- |
| Refuses LAN bind | Missing auth token and insecure=false. | Set `DASHBOARD_AUTH_TOKEN` or explicitly set `DASHBOARD_INSECURE=true`. |
| Shows stale data | Bot service not writing DB or dashboard refresh interval. | Check scanner service and DB timestamps. |
| 401 responses | Missing/wrong `x-dashboard-token`. | Use header token from secret source; do not print it. |

## systemd user services

Service templates:

```text
systemd/memecoin-alpha-bot.service
systemd/memecoin-alpha-dashboard.service
```

Install helper:

```bash
./scripts/install-user-service.sh
```

Bot service behavior:

- working directory: `/home/thetopham/memecoin-alpha-bot`
- environment file: `/home/thetopham/memecoin-alpha-bot/.env`
- command: `npm run start`
- restart: always, with 10s delay
- hardening: `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`
- write access: repo `data` and `config`

Dashboard service behavior:

- working directory: `/home/thetopham/memecoin-alpha-bot`
- environment file: `/home/thetopham/memecoin-alpha-bot/.env`
- command: compiled dashboard on `0.0.0.0:8788`
- write access: repo `data`

Useful commands:

```bash
systemctl --user status memecoin-alpha-bot.service --no-pager
systemctl --user status memecoin-alpha-dashboard.service --no-pager
journalctl --user -u memecoin-alpha-bot.service --since '30 minutes ago' --no-pager -n 120
journalctl --user -u memecoin-alpha-dashboard.service --since '30 minutes ago' --no-pager -n 120
systemctl --user restart memecoin-alpha-bot.service
systemctl --user restart memecoin-alpha-dashboard.service
```

## Hermes cron/scripts

Hermes automation is optional but useful for operations.

Known jobs:

- health watchdog;
- paper position manager;
- wallet scanner/maintainer.

See `docs/hermes-integration.md` for job IDs, prompts, boundaries, and safe reporting behavior.

## Rate limiting and retry utility

Shared request behavior lives in `rateLimit.ts`.

Core patterns:

- `AsyncRateLimiter` serializes/paces outbound calls.
- `fetchWithTimeoutAndRetry()` handles request timeout, retries, and transient failures.
- Integrations should use these helpers rather than unbounded raw fetch loops.

When adding an integration:

1. Define a conservative timeout.
2. Define retry count and backoff.
3. Add a rate limiter.
4. Make missing/unavailable data explicit.
5. Avoid crashing long-lived scanner loops for one provider failure.
6. Log enough context without secrets.
7. Add tests with mocked fetch.

## Secrets inventory

Potential secrets:

- `HELIUS_API_KEY`
- API key embedded inside `SOLANA_RPC_URL`
- API key embedded inside `HELIUS_WS_URL`
- `CIELO_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID` may be sensitive routing info
- `GROK_API_KEY` placeholder for future CT scanner work
- `DASHBOARD_AUTH_TOKEN`

Safe docs should use placeholders only:

```text
YOUR_HELIUS_API_KEY
[REDACTED]
```

Never paste real `.env` values into docs, reports, issue comments, or assistant summaries.

## Integration test posture

The test suite should mock external providers. Unit tests should not depend on live Helius, DexScreener, Cielo, Telegram, or dashboard network availability.

Use live calls only for explicit operator checks such as:

```bash
npm run scan:once
npm run report -- --refresh
npm run discover-wallets
```

These commands can consume API budget.

## Adding a new integration

Before adding:

1. Decide whether it is read-only, local-write, or external-write.
2. Confirm it does not require private keys/live trading.
3. Add env placeholders to `.env.example` only if operator-facing.
4. Parse config in `config.ts` with safe defaults.
5. Use rate limiting/retry utilities.
6. Add tests.
7. Document in this file and `docs/configuration.md`.
8. Confirm dashboard does not become an API caller unless explicitly redesigned.
9. Confirm logs do not reveal secrets.

If it can mutate money, stop and write a separate live-trading design before implementation.
