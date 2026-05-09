# Operations runbook

This is the practical operator guide for running the dry-run scanner, dashboard, wallet maintenance, Cielo discovery, and systemd/Hermes automation.

## Golden rules

1. Keep `DRY_RUN=true`.
2. Do not add private keys to this repo.
3. Keep `.env` mode `0600` and do not paste its contents into chat/logs/docs.
4. Treat `config/watched-wallets.json` as live operational state.
5. Inspect watchlist diffs before committing.
6. Bind dashboard to loopback unless you explicitly configure auth or accept LAN no-auth mode.
7. If a signal fires, review the paper evidence; do not treat it as an instruction to live trade.

## Fresh local setup

```bash
cd /home/thetopham/memecoin-alpha-bot
npm install
cp .env.example .env
chmod 600 .env
# Edit .env locally. Fill Helius/Solana settings and keep DRY_RUN=true.
npm run lint
npm test
npm run build
```

Minimum useful `.env` edits:

- Set `HELIUS_API_KEY` or `SOLANA_RPC_URL`.
- Keep `DRY_RUN=true`.
- Optionally set Telegram alerts.
- Optionally set `DASHBOARD_AUTH_TOKEN` before LAN dashboard use.
- Optionally set `CIELO_API_KEY` before wallet discovery.

## Smoke test flow

Run from the repo root:

```bash
npm run wallets
npm run scan:once
npm run status
npm run report
```

Expected first-run behavior:

- If a wallet has no checkpoint and `--include-history` is not used, the bot records the latest signature and processes no historical transactions for that wallet.
- This prevents stale historical wallet activity from producing surprise alerts.
- A signal requires at least 2 enabled non-archive watched wallets by default.

Historical smoke test, bounded by signature page limits:

```bash
npm run scan:once -- --include-history
npm run report -- --refresh
```

Use historical mode intentionally. It is useful for parser/scoring smoke tests, but it can create old paper entries if the historical transactions line up.

## Daily operator commands

Status without external market refresh:

```bash
npm run status
```

Status with open-position refresh first:

```bash
npm run status -- --refresh
```

Report with recent signals:

```bash
npm run report
```

Report with position refresh:

```bash
npm run report -- --refresh
```

Wallet scoreboard:

```bash
npm run wallet-performance -- 12
```

One scan:

```bash
npm run scan:once
```

Continuous foreground scanner:

```bash
npm run dev
```

Compiled scanner:

```bash
npm run build
npm run start
```

## Wallet operations

Review active wallets:

```bash
npm run wallets
```

Add/update a wallet manually:

```bash
npm run add-wallet -- <WALLET_ADDRESS> <label> 0.6
```

Force wallet maintenance:

```bash
npm run wallet-maintenance
```

After any wallet write:

```bash
git diff -- config/watched-wallets.json
git status --short
```

Backup behavior:

- Watchlist writes create timestamped backups in `config/.wallet-backups/` when the file already exists.
- The write uses a temporary file and atomic rename.

Rollback from a backup if needed:

```bash
cp config/.wallet-backups/<backup-file>.bak config/watched-wallets.json
npm run wallets
```

## Candidate wallet vetting

Candidate source file:

```text
config/wallet-candidates.json
```

Read-only vetting:

```bash
npm run vet-wallets -- --signatures=40
```

Apply only `keep` candidates:

```bash
npm run vet-wallets -- --apply --signatures=40
```

Avoid `--include-probation` unless you intentionally want more signal noise. Low-trust wallets still count toward the current 2-wallet convergence threshold.

Report output:

```text
data/wallet-vetting-report.json
```

## Cielo discovery

Cielo discovery requires a valid `CIELO_API_KEY` if the configured Cielo API endpoints require auth.

Run discovery:

```bash
npm run discover-wallets
```

Default outputs:

```text
config/cielo-wallet-candidates.json
data/cielo-wallet-discovery-report.json
```

Then either:

- inspect candidates manually; or
- let wallet maintenance add a bounded candidate batch; or
- run `npm run wallet-maintenance` to force candidate sync/rotation.

Remember: Cielo/Dune/public lists are seed pools. They are not proof of copyable edge.

## Dashboard

Local loopback dashboard:

```bash
npm run dashboard -- --host 127.0.0.1 --port 8788 --refresh 15
```

Open:

```text
http://127.0.0.1:8788/
```

JSON API:

```bash
curl http://127.0.0.1:8788/api/dashboard
```

LAN dashboard with auth:

```bash
# Put this in .env, not in shell history if avoidable:
# DASHBOARD_AUTH_TOKEN=[REDACTED]
npm run dashboard -- --host 0.0.0.0 --port 8788 --refresh 15
curl -H 'x-dashboard-token: [REDACTED]' http://127.0.0.1:8788/api/dashboard
```

Auth rules:

- Non-loopback bind without `DASHBOARD_AUTH_TOKEN` fails unless `DASHBOARD_INSECURE=true`.
- Header auth is `x-dashboard-token`.
- Query-string tokens are rejected by design.

Dashboard data-source boundary:

- Reads local SQLite and watchlist state.
- Does not call Helius, Solana RPC, Cielo, DexScreener, or pump.fun.
- Does not mutate watchlist or DB except normal SQLite connection side effects.
- Does not perform swaps or exits.

## User systemd service: scanner

Service template:

```text
systemd/memecoin-alpha-bot.service
```

Installer:

```bash
cd /home/thetopham/memecoin-alpha-bot
bash scripts/install-user-service.sh
```

Then:

```bash
systemctl --user daemon-reload
systemctl --user enable memecoin-alpha-bot.service
systemctl --user start memecoin-alpha-bot.service
systemctl --user status memecoin-alpha-bot.service --no-pager
journalctl --user -u memecoin-alpha-bot.service -f
```

The service:

- Runs from `/home/thetopham/memecoin-alpha-bot`.
- Reads `.env` through `EnvironmentFile`.
- Runs `/home/thetopham/.local/bin/npm run start`.
- Restarts automatically.
- Uses `NoNewPrivileges=true`, `PrivateTmp=true`, and `ProtectSystem=full`.
- Allows writes to repo `data` and `config`.

Before enabling long-term:

```bash
npm run lint
npm test
npm run build
npm run scan:once
npm run status
```

## User systemd service: dashboard

Service template:

```text
systemd/memecoin-alpha-dashboard.service
```

Install manually if needed:

```bash
mkdir -p ~/.config/systemd/user
cp systemd/memecoin-alpha-dashboard.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable memecoin-alpha-dashboard.service
systemctl --user start memecoin-alpha-dashboard.service
systemctl --user status memecoin-alpha-dashboard.service --no-pager
journalctl --user -u memecoin-alpha-dashboard.service -f
```

The dashboard template binds:

```text
0.0.0.0:8788
```

So `.env` must contain either:

```text
DASHBOARD_AUTH_TOKEN=[REDACTED]
```

or an explicit accepted exception:

```text
DASHBOARD_INSECURE=true
```

The current known LAN URL is:

```text
http://192.168.0.32:8788/
```

Use the header token if auth is enabled.

## Systemd lifecycle commands

Scanner:

```bash
systemctl --user status memecoin-alpha-bot.service --no-pager
systemctl --user restart memecoin-alpha-bot.service
systemctl --user stop memecoin-alpha-bot.service
journalctl --user -u memecoin-alpha-bot.service -n 200 --no-pager
journalctl --user -u memecoin-alpha-bot.service -f
```

Dashboard:

```bash
systemctl --user status memecoin-alpha-dashboard.service --no-pager
systemctl --user restart memecoin-alpha-dashboard.service
systemctl --user stop memecoin-alpha-dashboard.service
journalctl --user -u memecoin-alpha-dashboard.service -n 200 --no-pager
journalctl --user -u memecoin-alpha-dashboard.service -f
```

If the machine should run user services after login/session changes, check lingering:

```bash
loginctl show-user "$USER" -p Linger
```

Enable if intentionally desired:

```bash
loginctl enable-linger "$USER"
```

## Hermes operations jobs

The dashboard embeds the currently documented Hermes jobs:

| Job | ID | Schedule | Script | Purpose |
| --- | --- | --- | --- | --- |
| Bot Health Watchdog | `2b59421d3551` | every 10m | `~/.hermes/scripts/memecoin_bot_health_watchdog.py` | service/auth/API-budget/log watchdog; silent on OK. |
| Position Manager | `f7822adb2503` | every 20m | `~/.hermes/scripts/memecoin_position_manager.py` | paper open-position stale/near-stop/dormant checks; no live exits/swaps/private-key path. |
| Wallet Scanner / Maintainer | `bd525bf8d155` | `17 */6 * * *` | `~/.hermes/scripts/memecoin_wallet_scanner.py` | Cielo discovery plus bounded candidate add/rotation maintenance with watchlist backups. |

Hermes should stay inside these boundaries:

- Read status/report/dashboard.
- Alert on service, auth, budget, disk, logs, stale data, or paper-position conditions.
- Run Cielo discovery and wallet maintenance when configured.
- Add a wallet only when explicitly asked or through the bounded candidate workflow.
- Never create live execution/private-key support without explicit separate approval.

## Health checks

Basic app checks:

```bash
npm run status
npm run report
npm run wallet-performance -- 12
```

Build/test checks:

```bash
npm run lint
npm test
npm run build
```

Service checks:

```bash
systemctl --user is-active memecoin-alpha-bot.service
systemctl --user is-active memecoin-alpha-dashboard.service
journalctl --user -u memecoin-alpha-bot.service -n 100 --no-pager
journalctl --user -u memecoin-alpha-dashboard.service -n 100 --no-pager
```

Dashboard checks:

```bash
curl -sS http://127.0.0.1:8788/api/dashboard | python -m json.tool >/tmp/memecoin-dashboard.json
```

With auth:

```bash
curl -sS -H 'x-dashboard-token: [REDACTED]' http://127.0.0.1:8788/api/dashboard | python -m json.tool >/tmp/memecoin-dashboard.json
```

Database file presence:

```bash
test -f /home/thetopham/memecoin-alpha-bot/data/memecoin-alpha.sqlite && echo ok
```

## API budget monitoring

Budget status appears in:

- startup logs
- `npm run status`
- dashboard API/HTML

If mode is `conserve`:

- Candidate scans may pause.
- Hot/probation wallets should still be prioritized unless hard budget is crossed.

If mode is `emergency`:

- All wallet tier scans are refused by budget gating.
- Stop long-running scans if the provider dashboard shows real quota pressure.
- Consider increasing intervals or lowering wallet limits.

Useful knobs:

```text
POLL_INTERVAL_SECONDS
HOT_WALLET_SCAN_INTERVAL_SECONDS
PROBATION_WALLET_SCAN_INTERVAL_SECONDS
CANDIDATE_WALLET_SCAN_INTERVAL_SECONDS
HOT_WALLET_LIMIT
PROBATION_WALLET_LIMIT
CANDIDATE_WALLET_LIMIT
SIGNATURE_LIMIT
WALLET_SIGNATURE_MAX_PAGES
HELIUS_SOFT_DAILY_CREDITS
HELIUS_HARD_DAILY_CREDITS
```

## Common troubleshooting

### `Live trading is intentionally disabled in v1`

Cause: `DRY_RUN=false` or equivalent false value.

Fix:

```text
DRY_RUN=true
```

### First scan finds zero events

Likely normal. Without `--include-history`, the first scan sets checkpoints and avoids historical alerts.

Use a bounded historical scan only if desired:

```bash
npm run scan:once -- --include-history
```

### No signals despite events

Check:

- At least 2 active wallets.
- Wallets bought the same mint, not just any tokens.
- Buys were inside `SIGNAL_WINDOW_SECONDS`.
- Duplicate signal suppression did not already record the token recently.
- Candidate/probation scan intervals did not skip the relevant wallets.

Commands:

```bash
npm run wallets
npm run report
npm run wallet-performance -- 20
```

### Signal skipped

A skip is usually expected risk gating. Check `npm run report` for reasons/warnings.

Common reasons:

- Score below `MIN_COMPOSITE_SCORE`.
- Volume too low.
- Liquidity unavailable or too thin.
- Top-10 holders too concentrated.
- Sell pressure dominates 5m flow.

See `scoring-and-paper-trading.md`.

### Market data unavailable

The signal enters the retry queue. The queue retries after 30s, 90s, 180s, and 480s.

If this happens often:

- The token may be too new for indexers.
- DexScreener/pump.fun endpoints may be rate-limiting or unavailable.
- RPC holder analysis may be slow or failing.

### Dashboard refuses to start on LAN

Error:

```text
Dashboard refuses non-loopback bind without DASHBOARD_AUTH_TOKEN. Set token or bind to 127.0.0.1.
```

Fix one:

```bash
npm run dashboard -- --host 127.0.0.1 --port 8788
```

or set:

```text
DASHBOARD_AUTH_TOKEN=[REDACTED]
```

or explicitly accept no-auth LAN:

```text
DASHBOARD_INSECURE=true
```

### Dashboard returns 401

Send the header:

```bash
curl -H 'x-dashboard-token: [REDACTED]' http://127.0.0.1:8788/api/dashboard
```

Do not put the token in the URL.

### Wallet maintenance changed too much

Inspect diff:

```bash
git diff -- config/watched-wallets.json
```

Restore from backup:

```bash
cp config/.wallet-backups/<backup>.bak config/watched-wallets.json
npm run wallets
```

Then tune:

```text
ENABLE_WALLET_CANDIDATE_AUTO_ADD=false
ENABLE_WALLET_AUTO_ROTATION=false
WALLET_CANDIDATE_AUTO_ADD_BATCH_LIMIT=0
```

or lower tier limits.

### RPC rate limiting / high API usage

Tune down:

```text
POLL_INTERVAL_SECONDS=30
HOT_WALLET_SCAN_INTERVAL_SECONDS=30
PROBATION_WALLET_SCAN_INTERVAL_SECONDS=900
CANDIDATE_WALLET_SCAN_INTERVAL_SECONDS=7200
SIGNATURE_LIMIT=8
WALLET_SIGNATURE_MAX_PAGES=3
```

Check provider dashboard separately. Bot-logged credits are only local estimates.

### TypeScript build fails after code changes

Run:

```bash
npm run lint
npm test
npm run build
```

Fix type errors before restarting services.

## Safe update procedure

Before pulling or editing code:

```bash
cd /home/thetopham/memecoin-alpha-bot
git status --short
```

If `config/watched-wallets.json` is modified, treat it as user/operational state and do not overwrite it casually.

After code/doc changes:

```bash
npm run lint
npm test
npm run build
git diff --stat
git diff -- README.md docs src tests package.json tsconfig.json
```

Restart services if compiled runtime changed:

```bash
systemctl --user restart memecoin-alpha-bot.service
systemctl --user restart memecoin-alpha-dashboard.service
```

Docs-only changes do not require service restart.

## Backups

At minimum, back up:

```text
.env                         # secret, do not commit
config/watched-wallets.json  # operational watchlist
config/.wallet-backups/      # generated watchlist snapshots
data/memecoin-alpha.sqlite   # paper ledger and runtime state
```

SQLite uses WAL mode, so if making a cold file copy while services are running, include sidecars:

```text
data/memecoin-alpha.sqlite-wal
data/memecoin-alpha.sqlite-shm
```

Simplest safe manual backup:

```bash
systemctl --user stop memecoin-alpha-bot.service
systemctl --user stop memecoin-alpha-dashboard.service
mkdir -p ~/memecoin-alpha-backups
cp -a .env config data ~/memecoin-alpha-backups/memecoin-alpha-$(date +%Y%m%d-%H%M%S)
systemctl --user start memecoin-alpha-bot.service
systemctl --user start memecoin-alpha-dashboard.service
```

## Incident response boundaries

If the bot appears wrong or noisy:

1. Stop the scanner service.
2. Leave dashboard running if it is useful for read-only inspection.
3. Inspect logs and `npm run report`.
4. Preserve the SQLite DB and watchlist before modifying.
5. Disable candidate auto-add/rotation if the watchlist is the suspected source.
6. Do not add live-trading code as a quick fix.

Stop scanner:

```bash
systemctl --user stop memecoin-alpha-bot.service
```

Disable wallet mutation:

```text
ENABLE_WALLET_CANDIDATE_AUTO_ADD=false
ENABLE_WALLET_AUTO_ROTATION=false
```

Then restart after config edit:

```bash
systemctl --user restart memecoin-alpha-bot.service
```
