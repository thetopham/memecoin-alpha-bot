# Hermes integration

Hermes is the operator layer around this repo. The memecoin alpha bot remains a separate dry-run scanner service; Hermes may inspect it, summarize it, and run bounded maintenance jobs, but should not cross into live trading.

## Boundary

Allowed by default:

- Read `npm run status` and summarize.
- Read `npm run report` and summarize signals, skips, exits, and wallet performance.
- Start/stop/restart the user systemd services when asked.
- Check dashboard health and auth behavior.
- Run `npm run scan:once` for an explicit status check.
- Run `npm run wallet-performance -- <limit>`.
- Add a specific wallet when the user explicitly provides it.
- Run Cielo discovery / wallet maintenance when configured as a scheduled ops job.
- Alert the user about service failures, stale data, API budget pressure, dashboard auth issues, disk/log problems, or suspicious paper-position conditions.

Not allowed without a separate explicit approval scope:

- Add private key support.
- Store seed phrases or private keys.
- Add live swap/order execution.
- Increase risk limits for a future live system.
- Auto-buy/sell anything.
- Convert Telegram/report alerts into live order instructions.
- Bulk-add unvetted wallets outside bounded candidate workflows.
- Disable `DRY_RUN=true`.

## Current project path

```text
/home/thetopham/memecoin-alpha-bot
```

Most Hermes prompts should tell Hermes to run commands in that working directory.

## Useful Hermes prompts

Status:

```text
Check the memecoin alpha bot status. In /home/thetopham/memecoin-alpha-bot, run `npm run status` and summarize mode, wallet tiers, API budget, paper trades, recent wallet performance, and anything actionable. Do not expose secrets.
```

Report:

```text
Show the latest memecoin alpha report. In /home/thetopham/memecoin-alpha-bot, run `npm run report` and summarize recent signals, skip reasons, open paper positions, final exits, and wallet-performance implications. Keep it paper-trading only.
```

Refreshed report:

```text
Refresh and summarize the memecoin alpha report. In /home/thetopham/memecoin-alpha-bot, run `npm run report -- --refresh`; summarize open positions, exits, API budget, and one suggested next operator action. Do not make live trades.
```

Add a wallet:

```text
Add this Solana wallet to the memecoin alpha bot watchlist with trust 0.6 and label <label>: <wallet>. Preserve existing watchlist changes, then show the resulting diff for config/watched-wallets.json. Do not run live trading.
```

Vet candidate wallets:

```text
Vet candidate wallets for the memecoin alpha bot. In /home/thetopham/memecoin-alpha-bot, run `npm run vet-wallets -- config/cielo-wallet-candidates.json --signatures=40`, summarize keep/probation/reject counts, and do not apply changes unless I explicitly approve.
```

Service health:

```text
Check memecoin alpha bot service health. Inspect user systemd status/journal for memecoin-alpha-bot.service and memecoin-alpha-dashboard.service, then run `npm run status` in /home/thetopham/memecoin-alpha-bot. Summarize failures and safe fixes only.
```

## Hermes cron jobs

The current ops automation is represented in the dashboard and operations docs.

| Job | ID | Schedule | Script | Delivery behavior |
| --- | --- | --- | --- | --- |
| Bot Health Watchdog | `2b59421d3551` | every 10m | `~/.hermes/scripts/memecoin_bot_health_watchdog.py` | Silent on OK; alerts only on health/auth/API-budget/log/disk issues. |
| Position Manager | `f7822adb2503` | every 20m | `~/.hermes/scripts/memecoin_position_manager.py` | Cooldown-based paper-position alerts; no live exits/swaps/private keys. |
| Wallet Scanner / Maintainer | `bd525bf8d155` | `17 */6 * * *` | `~/.hermes/scripts/memecoin_wallet_scanner.py` | Reports because it can mutate candidate/watchlist state; bounded candidate adds and backups. |

Inspect jobs with Hermes CLI:

```bash
hermes cron list
```

Run a job manually if needed:

```bash
hermes cron run <job_id>
```

Do not create recursive cron jobs from a cron-run session.

## Recommended cron prompt boundaries

A good recurring prompt should be self-contained and should say:

- Workdir: `/home/thetopham/memecoin-alpha-bot`.
- Keep `DRY_RUN=true`; do not add live trading.
- Do not read or print `.env` secret values.
- Preserve `config/watched-wallets.json` backups/diffs.
- Prefer no-agent script-only watchdogs when the script can produce exact alert text.
- Stay silent on OK for high-frequency health checks.
- Send concise alert/report with evidence and one safe next action.

Example health-watchdog boundary:

```text
You are checking the memecoin alpha bot. Use /home/thetopham/memecoin-alpha-bot. Verify the user services, recent logs, dashboard/API health, API budget mode, DB freshness, and disk space. If everything is OK, stay silent if the script produced no alert. If something is wrong, summarize evidence and safe operator commands. Never expose secrets. Never trade. Never edit config unless explicitly requested.
```

Example wallet-maintainer boundary:

```text
You are running bounded memecoin wallet maintenance. Use /home/thetopham/memecoin-alpha-bot. Run discovery/vetting/maintenance only as configured by the script. If config/watched-wallets.json changes, include a concise summary of added/promoted/demoted/archived wallets and confirm a backup path exists. Do not include secrets. Do not add live trading. Do not exceed configured candidate batch limits.
```

## Dashboard and Hermes

The bot dashboard is safe for Hermes to read:

- `/api/dashboard` exposes local state only.
- It includes Hermes ops cron metadata.
- It does not call live market APIs.
- It does not mutate state.
- It does not expose `.env` secrets.

If auth is enabled, Hermes scripts should send the `x-dashboard-token` header from a secret source, not as a URL query parameter.

## Watchlist mutation rules for Hermes

Before Hermes changes the watchlist:

```bash
git status --short
git diff -- config/watched-wallets.json
```

After Hermes changes the watchlist:

```bash
npm run wallets
git diff -- config/watched-wallets.json
```

Hermes should report:

- what command changed it;
- backup path if generated;
- how many wallets are active by tier;
- whether the change was explicit user-requested, candidate auto-add, or rotation;
- any high-risk additions such as probation wallets.

Hermes should not hide watchlist changes inside a generic success message.

## Incident examples

### Bot service down

Safe response:

1. Inspect `systemctl --user status memecoin-alpha-bot.service`.
2. Inspect recent journal lines.
3. Run `npm run build` only if logs suggest code/build issue.
4. Restart service if config/build is valid.
5. Report the failure and fix.

Unsafe response:

- Editing strategy thresholds or wallet files without evidence.
- Adding live execution to “recover” missed trades.

### API budget emergency

Safe response:

1. Report budget mode and local bot-logged credits.
2. Recommend reducing scan cadence/limits.
3. Optionally stop the scanner if the user approves or if the watchdog is explicitly designed to do so.
4. Remind that provider dashboard is authoritative.

Unsafe response:

- Rotating API keys automatically.
- Raising hard budget without user approval.

### No signals for a while

Safe response:

1. Check active wallet count and tiers.
2. Check recent events/wallet performance.
3. Suggest candidate discovery/vetting or threshold review.
4. Avoid overreacting; no signals may be correct.

Unsafe response:

- Lowering thresholds or adding noisy wallets without review.

### Paper position near stop

Safe response:

1. Alert with token, entry, current PnL, stop/trailing context, and last update time.
2. Say no live exit exists.
3. Suggest reviewing report/dashboard.

Unsafe response:

- Attempting a live sell.

## Creating a dedicated Hermes skill

If this workflow becomes frequent, create a local Hermes skill for it. The skill should include:

- project path;
- core commands;
- dry-run boundary;
- dashboard URL/auth note;
- watchlist mutation rules;
- common runbooks;
- links to these docs.

A skill keeps future Hermes sessions from rediscovering the repo. Keep it concise and point back to `docs/` for details.

## Minimum context Hermes should include in reports

For a chief-of-staff style summary, include:

- health: services, DB/dashboard freshness, API budget mode;
- signal state: recent passed/skipped signals and reasons;
- paper state: open positions, near-stop/trailing/old positions, closed exits;
- wallet state: best/worst attributed wallets and any tier changes;
- risk boundary: confirm paper-only/no live action;
- one next safe action: e.g. review a signal, vet candidates, tune cadence, or leave unchanged.

Avoid giant raw logs unless requested.
