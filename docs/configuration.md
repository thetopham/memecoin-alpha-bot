# Configuration reference

This document covers every configuration surface used by the bot: environment variables, watched-wallet JSON, candidate files, SQLite tables, dashboard settings, systemd environment handling, and secret hygiene.

## Configuration sources and precedence

Primary sources:

1. `.env` in the repo root, loaded by `dotenv` in `src/config.ts`.
2. Process environment variables provided by shell/systemd/Hermes.
3. Defaults and bounds in `loadConfig()`.
4. JSON files under `config/` for wallet state.
5. SQLite state under `data/memecoin-alpha.sqlite` for runtime checkpoints and ledgers.

Important path behavior:

- `WATCHED_WALLETS_PATH`, `DB_PATH`, `CIELO_CANDIDATE_PATH`, and `CIELO_DISCOVERY_REPORT_PATH` are resolved relative to `process.cwd()` when relative.
- Run commands from the repo root unless you intentionally override paths.
- The systemd units set `WorkingDirectory=/home/thetopham/memecoin-alpha-bot`, so relative paths resolve correctly there.

## Secret hygiene

Secrets must live only in `.env` or external service secret stores.

Never commit or paste:

- Helius API keys.
- Solana RPC URLs containing real API keys.
- Cielo API keys.
- Telegram bot tokens or chat IDs if private.
- Dashboard auth tokens.
- Any future wallet private key or seed phrase. This repo should not have one.

Recommended local permissions:

```bash
chmod 600 /home/thetopham/memecoin-alpha-bot/.env
```

Documentation should use placeholders such as `YOUR_HELIUS_API_KEY` or `[REDACTED]`, never real values.

## Required safety setting

| Variable | Default | Required? | Notes |
| --- | --- | --- | --- |
| `DRY_RUN` | `true` | Yes | `loadConfig()` throws if this evaluates to false. V1 is paper-only. |

Boolean parsing accepts `1`, `true`, `yes`, or `on` case-insensitively. Anything else is false unless the fallback is true.

## Solana / Helius configuration

| Variable | Default / bounds | Purpose |
| --- | --- | --- |
| `HELIUS_API_KEY` | unset | Optional key used to build default Helius RPC/WebSocket URLs. |
| `SOLANA_RPC_URL` | If `HELIUS_API_KEY` is set: `https://beta.helius-rpc.com/?api-key=...`; otherwise `https://api.mainnet-beta.solana.com` | RPC endpoint for signatures, parsed transactions, token supply, and largest token accounts. |
| `HELIUS_WS_URL` | If `HELIUS_API_KEY` is set: `wss://mainnet.helius-rpc.com/?api-key=...`; otherwise unset | Reserved websocket URL. Current scanner uses polling, not transactionSubscribe. |
| `RPC_TIMEOUT_MS` | default `15000`, bounded 1000-60000 | Per-request timeout for Solana RPC. |
| `RPC_MAX_RETRIES` | default `5`, bounded 0-10 | Retry attempts for RPC fetches. |
| `RPC_MIN_INTERVAL_MS` | default `125`, bounded 0-5000 | Minimum spacing between RPC requests. Default is below common free-tier rate limits. |

The RPC wrapper logs request usage into the API usage table when connected through the budget hooks.

## API budget governor

| Variable | Default / bounds | Purpose |
| --- | --- | --- |
| `ENABLE_API_BUDGET_GOVERNOR` | `true` | Enables tier scan gating based on bot-logged daily usage. |
| `HELIUS_MONTHLY_CREDITS` | `10000000`, minimum 1 | Informational monthly credit assumption. |
| `HELIUS_SOFT_DAILY_CREDITS` | `250000`, minimum 1 | Enter conserve mode at/above this 24h usage level. |
| `HELIUS_HARD_DAILY_CREDITS` | `300000`, minimum 1 | Enter emergency mode / block scans at/above this 24h usage level. |

Modes:

- `normal`: below soft daily credits.
- `conserve`: at or above soft daily credits; candidate-tier scans pause first.
- `emergency`: at or above hard daily credits; all scans are refused.

The budget is based on `api_usage` rows recorded by this bot. Provider dashboards remain the source of truth for account billing/quotas.

## Scanner thresholds

| Variable | Default / bounds | Purpose |
| --- | --- | --- |
| `WATCHED_WALLETS_PATH` | `./config/watched-wallets.json` | Active watchlist JSON file. |
| `DB_PATH` | `./data/memecoin-alpha.sqlite` | SQLite DB path. |
| `POLL_INTERVAL_SECONDS` | default `30`, minimum `5`; `.env.example` uses `10` | Continuous scanner interval. |
| `SIGNATURE_LIMIT` | default `12`, bounded 1-50 | Signatures requested per wallet page. |
| `WALLET_SIGNATURE_MAX_PAGES` | default `6`, bounded 1-25 | Maximum signature pages for catch-up/history scans. |
| `PROCESS_HISTORICAL_ON_FIRST_RUN` | `false` | If false, first run records latest signature checkpoint without processing old transactions. |
| `MIN_WALLETS_FOR_SIGNAL` | default `2`, minimum `2` | Unique watched wallets required to emit convergence. |
| `SIGNAL_WINDOW_SECONDS` | default `300`, minimum `30` | Time window for same-token convergence. |
| `MIN_COMPOSITE_SCORE` | default `60`, bounded 0-100 | Minimum score for opening a paper trade after hard-fail gates pass. |

One active wallet can create events, but cannot create a signal. At least two active watched wallets are required by the config clamp.

## Wallet tiering and scan cadence

| Variable | Default / bounds | Purpose |
| --- | --- | --- |
| `HOT_WALLET_LIMIT` | `75`, bounded 1-500 | Maximum hot wallets retained by rotation. |
| `PROBATION_WALLET_LIMIT` | `150`, bounded 0-2000 | Maximum probation wallets retained. |
| `CANDIDATE_WALLET_LIMIT` | `500`, bounded 0-5000 | Maximum candidate wallets retained. |
| `HOT_WALLET_SCAN_INTERVAL_SECONDS` | defaults to `POLL_INTERVAL_SECONDS`, minimum `5` | Minimum interval between scans for hot wallets. |
| `PROBATION_WALLET_SCAN_INTERVAL_SECONDS` | `600`, minimum `30` | Minimum interval for probation wallets. |
| `CANDIDATE_WALLET_SCAN_INTERVAL_SECONDS` | `3600`, minimum `60` | Minimum interval for candidates. |
| `ENABLE_WALLET_AUTO_ROTATION` | `true` | Allows wallet tier changes from paper performance. |
| `ENABLE_WALLET_CANDIDATE_AUTO_ADD` | `true` | Allows candidate file entries to be inserted into watchlist as candidate tier. |
| `WALLET_CANDIDATE_AUTO_ADD_BATCH_LIMIT` | `25`, bounded 0-250 | Max candidate wallets added per maintenance run. |
| `WALLET_ROTATION_INTERVAL_SECONDS` | `3600`, minimum `300` | Minimum interval between automatic maintenance runs unless forced. |

Tiers:

- `hot`: fastest scan cadence, trusted active set.
- `probation`: slower cadence, still useful but not top tier.
- `candidate`: slow cadence, low trust, mostly for proving/disproving utility.
- `archive`: disabled for scanning.

## Paper trading settings

| Variable | Default / bounds | Purpose |
| --- | --- | --- |
| `MAX_PAPER_POSITION_SOL` | `0.1`, minimum 0 | Simulated paper position size in SOL. |
| `PAPER_SOL_USD_FOR_ESTIMATES` | `90`, minimum 0 | Reference SOL/USD used to convert paper SOL size to notional USD for fill estimation. |
| `PAPER_COMPARISON_NOTIONAL_USD` | `100`, minimum 0 | Additional comparison fill/slippage notional stored on trades. |
| `STOP_LOSS_PERCENT` | `-40`, clamped to <= 0 | Close paper trade when current PnL is at/below this percent. |
| `TAKE_PROFIT_1_MULTIPLE` | `2` | First simulated take-profit threshold. |
| `TAKE_PROFIT_2_MULTIPLE` | `3` | Second simulated take-profit threshold. |
| `TAKE_PROFIT_3_MULTIPLE` | `5` | Third simulated take-profit threshold. |
| `PAPER_TRAILING_STOP_ACTIVATION_MULTIPLE` | `1.5`, minimum 1 | Trailing stop only activates after observed peak reaches this multiple. |
| `PAPER_TRAILING_STOP_DRAWDOWN_PERCENT` | `30`, bounded 0-95 | Close remaining inventory after this drawdown from observed peak. Set 0 to disable. |

Take-profit behavior updates `remaining_percent` only. It does not create multiple realized partial-trade rows. The final close PnL is based on final close price; report formatting separately explains remaining inventory and observed max multiple.

## Dashboard settings

Dashboard-specific env is read inside `startDashboardServer()` as well as from CLI args.

| Variable | Default / bounds | Purpose |
| --- | --- | --- |
| `DASHBOARD_HOST` | `127.0.0.1` | Bind host when not provided by CLI args. |
| `DASHBOARD_PORT` | `8788` | Bind port when not provided by CLI args. |
| `DASHBOARD_REFRESH_SECONDS` | `15`, minimum `5` | HTML auto-refresh interval. |
| `DASHBOARD_AUTH_TOKEN` | unset | Required when binding to non-loopback host unless insecure mode is accepted. |
| `DASHBOARD_INSECURE` | false | If true, allows non-loopback dashboard bind without auth. Use only by explicit local/LAN decision. |

Auth behavior:

- Non-loopback bind with no token and no insecure flag throws.
- When token is configured, clients must send it in the `x-dashboard-token` header.
- Query-string token auth is intentionally not accepted.
- The dashboard is read-only and local-state-only; it does not call external APIs.

Example local-only:

```bash
npm run dashboard -- --host 127.0.0.1 --port 8788
```

Example LAN with auth:

```bash
DASHBOARD_AUTH_TOKEN='[REDACTED]' npm run dashboard -- --host 0.0.0.0 --port 8788
curl -H 'x-dashboard-token: [REDACTED]' http://127.0.0.1:8788/api/dashboard
```

## Telegram alerts

| Variable | Default | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | unset | Telegram bot token for alerts. |
| `TELEGRAM_CHAT_ID` | unset | Chat/channel target for alerts. |

If either value is missing, alerts print to logs as `[ALERT]` and no Telegram API call is made. Telegram sends use a 1000ms rate limiter, 10s timeout, and up to 3 retries.

## Cielo discovery settings

| Variable | Default / bounds | Purpose |
| --- | --- | --- |
| `CIELO_API_KEY` | unset | Optional Cielo API key. Keep only in `.env`. |
| `CIELO_API_BASE_URL` | `https://feed-api.cielo.finance` | API base. |
| `CIELO_APP_BASE_URL` | `https://app.cielo.finance` | App/profile base. |
| `CIELO_CANDIDATE_PATH` | `./config/cielo-wallet-candidates.json` | Candidate wallet output path. |
| `CIELO_DISCOVERY_REPORT_PATH` | `./data/cielo-wallet-discovery-report.json` | Discovery report output path. |
| `CIELO_MIN_PNL_USD` | `500`, minimum 0 | Candidate minimum realized PnL. |
| `CIELO_MIN_ROI_PERCENT` | `50`, minimum 0 | Candidate minimum ROI. |
| `CIELO_MIN_WINRATE_PERCENT` | `45`, bounded 0-100 | Candidate minimum win rate. |
| `CIELO_MAX_LAST_ACTIVE_HOURS` | `48`, minimum 1 | Candidate recency filter. |
| `CIELO_MAX_CANDIDATES` | `60`, bounded 1-500 | Max candidates written. |
| `CIELO_DISCOVERY_PAGES` | `2`, bounded 1-10 | Discovery pages to fetch. |
| `CIELO_FEED_MIN_USD` | `25`, minimum 0 | Feed trade minimum USD. |
| `CIELO_FEED_LOOKBACK_HOURS` | `24`, minimum 1 | Feed recency window. |
| `CIELO_VETTING_SIGNATURE_LIMIT` | `40`, bounded 1-100 | RPC signature sample for vetting. |

Cielo discovery is not part of every scan. It runs via explicit CLI/Hermes workflows and can write candidate/report files.

## Placeholder CT scanner settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `ENABLE_CT_SCANNER` | `false` | Placeholder flag for later Crypto Twitter/momentum scanning. |
| `GROK_API_KEY` | unset | Placeholder secret for a future Grok/X hook. Not used by the current scanner. |

Do not assume CT scanning exists because these variables exist. They are reserved hooks.

## Watchlist file schema

Path by default:

```text
config/watched-wallets.json
```

The file must be a JSON array. Each item is normalized as `WalletConfig`:

```json
{
  "address": "SOLANA_WALLET_ADDRESS",
  "label": "human-readable source label",
  "trust": 0.6,
  "enabled": true,
  "tier": "hot",
  "source": "cielo",
  "notes": "why this wallet is being watched",
  "addedAt": "2026-05-09T00:00:00.000Z",
  "lastTierChangeAt": "2026-05-09T00:00:00.000Z",
  "archivedAt": null
}
```

Field behavior:

| Field | Required? | Behavior |
| --- | --- | --- |
| `address` | yes | Must match the Solana base58-ish address regex: 32-44 chars excluding invalid base58 chars. |
| `label` | no | Trimmed; omitted if empty. |
| `trust` | no | Defaults to `1`. Rotation rounds/clamps suggestions 0-1. Candidate auto-add caps trust at 0.35 or uses 0.3. |
| `enabled` | no | Defaults to true. `false` excludes wallet from active scans. |
| `tier` | no | One of `hot`, `probation`, `candidate`, `archive`; defaults to `hot`. |
| `source` | no | Free-form source tag such as `cielo`, `dune`, `manual`, `solscan`. |
| `notes` | no | Free-form operator notes. |
| `addedAt` | no | ISO timestamp for provenance. |
| `lastTierChangeAt` | no | ISO timestamp set by rotation when tier/trust/enabled changes. |
| `archivedAt` | no | ISO timestamp set when archived. |
| extra fields | no | Preserved because `WalletConfig` allows unknown keys. |

Active wallets are `enabled !== false` and `tier !== 'archive'`.

## Wallet file write behavior

`writeWalletFile()` is intentionally cautious:

- Creates parent directories.
- Creates a timestamped backup in `config/.wallet-backups/` by default if the file exists.
- Writes a temporary file with mode `0600`.
- Atomically renames the temp file into place.
- Normalizes each wallet before writing.

Commands that can write the watchlist:

- `npm run add-wallet -- ...`
- `npm run wallet-maintenance`
- continuous scans when maintenance is due and changes are generated
- Hermes wallet-maintainer job, if configured and enabled

Inspect `git diff -- config/watched-wallets.json` before committing watchlist changes.

## Candidate files

The candidate sync path defaults to:

```text
config/cielo-wallet-candidates.json
```

Candidate files are also JSON arrays of `WalletConfig`-compatible objects. `readCandidateFile()` normalizes each candidate with the same wallet schema.

When candidate auto-add runs:

- Existing watched addresses are skipped.
- New entries are added as `enabled: true`, `tier: candidate`.
- Trust is capped at 0.35 or defaults to 0.3.
- `addedAt` and `lastTierChangeAt` are set if needed.
- A cautionary note is appended.
- Adds are bounded by `WALLET_CANDIDATE_AUTO_ADD_BATCH_LIMIT` and `CANDIDATE_WALLET_LIMIT`.

Other candidate files may exist for manual sources, e.g. `wallet-candidates.json` or Dune-derived files. They should be treated as seed pools, not proof of edge.

## SQLite database

Default path:

```text
data/memecoin-alpha.sqlite
```

`AlphaDb` creates tables on startup and uses WAL mode.

### `state`

Key/value runtime state.

| Column | Meaning |
| --- | --- |
| `key` | Primary key. Examples: `last_signature:<wallet>`, `last_wallet_scan:<wallet>`, `last_wallet_maintenance`. |
| `value` | String value. |
| `updated_at` | Unix seconds. |

### `wallet_events`

Normalized parsed swap events.

| Column | Meaning |
| --- | --- |
| `tx_hash` | Primary key transaction signature. |
| `wallet` | Watched wallet address. |
| `token_address` | Token mint. |
| `token_symbol` | Optional symbol. |
| `direction` | `buy` or `sell`. |
| `sol_amount` | Estimated SOL amount. |
| `timestamp` | Event Unix seconds. |
| `source` | `pumpfun`, `raydium`, `jupiter`, `orca`, or `unknown`. |
| `created_at` | Insert Unix seconds. |

Indexes:

- `idx_wallet_events_token_time(token_address, timestamp)`.
- `idx_wallet_events_wallet_time(wallet, timestamp)`.

### `signals`

Persisted convergence events and score results.

| Column | Meaning |
| --- | --- |
| `id` | Autoincrement primary key. |
| `token_address` | Token mint. |
| `symbol` | Score snapshot symbol. |
| `wallet_count` | Unique wallets in signal. |
| `weighted_trust` | Sum of participating wallet trust values. |
| `composite_score` | 0-100 score. |
| `pass` | Integer boolean after hard-fail and min-score gate. |
| `wallets_json` | Signal wallet metadata JSON. |
| `score_json` | Full token score JSON. |
| `fail_reasons` | Text summary of hard-fail reasons. |
| `warnings` | Text summary of warnings. |
| `created_at` | Insert Unix seconds. |

Index:

- `idx_signals_token_time(token_address, created_at)`.

### `api_usage`

Bot-logged API accounting.

| Column | Meaning |
| --- | --- |
| `id` | Autoincrement primary key. |
| `provider` | Provider tag, e.g. `helius`. |
| `endpoint` | Endpoint/method tag. |
| `credits` | Estimated credit units. |
| `status` | Request status tag, default `ok`. |
| `created_at` | Unix seconds. |

Indexes:

- `idx_api_usage_provider_time(provider, created_at)`.
- `idx_api_usage_time(created_at)`.

### `paper_trades`

Paper position lifecycle.

Base columns:

| Column | Meaning |
| --- | --- |
| `id` | Autoincrement primary key. |
| `token_address` | Token mint. |
| `symbol` | Token symbol at entry. |
| `entry_price_usd` | Simulated fill price. |
| `entry_sol` | Simulated SOL size. |
| `entry_time` | Entry Unix seconds. |
| `status` | `open` or `closed`. |
| `max_multiplier` | Highest observed price multiple. |
| `remaining_percent` | Simulated remaining inventory after TP levels. |
| `exit_price_usd` | Final close price when closed. |
| `exit_time` | Final close Unix seconds. |
| `pnl_percent` | Final close PnL percent. |
| `exit_reason` | Stop/trailing/tracked-sell reason. |
| `signal_id` | Link to `signals.id`. |

Additive columns created by `ensurePaperTradeColumns()`:

- `last_price_usd`
- `last_multiplier`
- `last_pnl_percent`
- `last_liquidity_usd`
- `last_checked_at`
- `observed_price_usd`
- `estimated_fill_price_usd`
- `estimated_slippage_bps`
- `estimated_price_impact_bps`
- `estimated_notional_usd`
- `reference_sol_usd`
- `comparison_notional_usd`
- `comparison_slippage_bps`
- `comparison_fill_price_usd`
- `effective_liquidity_usd`
- `liquidity_basis`
- `liquidity_confidence`
- `fill_model`
- `fill_source`
- `signal_first_seen_at`
- `signal_last_seen_at`
- `signal_created_at`
- `first_wallet_to_fill_seconds`
- `latest_wallet_to_fill_seconds`
- `signal_to_fill_seconds`

Index:

- `idx_paper_trades_status(status)`.

## Systemd environment

Service files live under `systemd/` and are meant to be installed as user services.

The bot service:

- Uses `WorkingDirectory=/home/thetopham/memecoin-alpha-bot`.
- Uses `EnvironmentFile=/home/thetopham/memecoin-alpha-bot/.env`.
- Runs `npm run start` from the user's npm path.
- Allows writes to repo `data` and `config`.

The dashboard service:

- Uses the same repo root and `.env`.
- Runs `npm run dashboard:dist -- --host 0.0.0.0 --port 8788 --refresh 15`.
- Allows writes to repo `data` for SQLite compatibility.
- Requires either `DASHBOARD_AUTH_TOKEN` or explicit `DASHBOARD_INSECURE=true` because it binds to LAN.

See `operations.md` for install/status/journal commands.

## Recommended `.env` creation flow

```bash
cd /home/thetopham/memecoin-alpha-bot
cp .env.example .env
chmod 600 .env
# edit .env locally; keep DRY_RUN=true
npm run lint
npm test
npm run build
npm run scan:once
npm run status
```

Before sharing logs or docs, scan for accidental secret output. The app should not print secret values, but shell history and manual notes can still leak them.
