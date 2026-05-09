# Data model and storage

This document describes the local files and SQLite tables that make the dry-run scanner auditable. The bot is designed around local durable state: wallet checkpoints, parsed wallet events, emitted signals, paper trades, API budget accounting, generated reports, and watchlist JSON.

## Storage overview

| Path | Purpose | Commit? |
| --- | --- | --- |
| `config/watched-wallets.json` | Active wallet watchlist and tiers. | Usually yes after review; do not auto-commit unreviewed changes. |
| `config/wallet-candidates.json` | Manual or imported candidate wallets. | Optional; depends on whether it contains useful non-secret research. |
| `config/cielo-wallet-candidates.json` | Generated Cielo candidate wallet file. | Usually no unless intentionally preserving research output. |
| `config/.wallet-backups/` | Watchlist backups before atomic writes. | Usually no. |
| `data/memecoin-alpha.sqlite` | Runtime SQLite DB. | No. |
| `data/*.json` | Generated reports and discovery/vetting output. | Usually no. |
| `dist/` | Build output. | Usually no unless deployment explicitly tracks built artifacts. |
| `.env` | Secrets and local runtime config. | Never. |
| `.env.example` | Placeholder config template. | Yes. |

The runtime DB is local state, not a source-of-truth ledger for real trades.

## SQLite connection behavior

The database layer uses Node 22's built-in `node:sqlite` module.

At startup it applies:

```sql
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
```

Implications:

- WAL sidecars such as `data/memecoin-alpha.sqlite-wal` and `data/memecoin-alpha.sqlite-shm` may exist while services run.
- Readers and writers can coexist better than with rollback journal mode.
- `busy_timeout` helps avoid immediate failures if dashboard/reporting reads while scanner writes.
- `synchronous=NORMAL` is a normal performance/durability tradeoff for local bot telemetry.

## Database tables

### `state`

Generic key/value state.

```sql
CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Known uses:

- per-wallet scan checkpoints;
- runtime timestamps;
- generic small state values.

Typical checkpoint pattern:

```text
wallet:<address>:last_signature
wallet:<address>:last_scanned_at
```

Exact keys should be treated as implementation details unless exposed by CLI/report output.

### `wallet_events`

Parsed wallet swap events.

```sql
CREATE TABLE IF NOT EXISTS wallet_events (
  tx_hash TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  token_address TEXT NOT NULL,
  token_symbol TEXT,
  direction TEXT NOT NULL,
  sol_amount REAL NOT NULL,
  timestamp INTEGER NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

Indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_wallet_events_token_time
  ON wallet_events(token_address, timestamp);

CREATE INDEX IF NOT EXISTS idx_wallet_events_wallet_time
  ON wallet_events(wallet, timestamp);
```

Semantics:

- `tx_hash` is primary key, so duplicate signatures are ignored.
- `direction` is `buy` or `sell`.
- `sol_amount` is the estimated SOL-side value parsed from the transaction.
- `timestamp` is block time, in Unix seconds.
- `created_at` is local insertion time, in Unix seconds.
- `source` identifies parser/source category such as Pump.fun, Raydium, Jupiter, Orca, or unknown.

This table records parsed events from watched wallets, not all wallet transactions.

### `signals`

Emitted convergence signals.

```sql
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL,
  symbol TEXT NOT NULL,
  wallet_count INTEGER NOT NULL,
  weighted_trust REAL NOT NULL,
  composite_score INTEGER NOT NULL,
  pass INTEGER NOT NULL,
  wallets_json TEXT NOT NULL,
  score_json TEXT NOT NULL,
  fail_reasons TEXT NOT NULL,
  warnings TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

Index:

```sql
CREATE INDEX IF NOT EXISTS idx_signals_token_time
  ON signals(token_address, created_at);
```

Semantics:

- Every emitted convergence can be recorded, including failed scoring signals.
- `pass` is `1` if token scoring passed all hard gates and composite threshold.
- `wallets_json` stores the participating wallets as JSON.
- `score_json` stores the full token score object.
- `fail_reasons` is a semicolon-delimited human string for reporting.
- `warnings` is a semicolon-delimited human string for reporting.
- `created_at` is local signal time, in Unix seconds.

Duplicate suppression:

- The DB exposes `hasRecentSignal(tokenAddress, sinceSeconds)`.
- Orchestrator uses it to avoid repeatedly opening/reporting the same token inside the signal window.

### `api_usage`

Local API usage accounting.

```sql
CREATE TABLE IF NOT EXISTS api_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  credits REAL NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

Indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_api_usage_provider_time
  ON api_usage(provider, created_at);

CREATE INDEX IF NOT EXISTS idx_api_usage_time
  ON api_usage(created_at);
```

Semantics:

- `provider` is usually `helius`, `cielo`, or another external API label.
- `endpoint` is a local endpoint/method label.
- `credits` is an estimate, not a provider-authoritative billing record.
- `status` records local outcome such as `ok` or error-ish state.
- `created_at` is Unix seconds.

This table powers budget summaries and soft/hard budget modes. Always compare with provider dashboards when precise billing matters.

### `paper_trades`

Paper positions opened from passing signals.

Base schema:

```sql
CREATE TABLE IF NOT EXISTS paper_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL,
  symbol TEXT NOT NULL,
  entry_price_usd REAL NOT NULL,
  entry_sol REAL NOT NULL,
  entry_time INTEGER NOT NULL,
  status TEXT NOT NULL,
  max_multiplier REAL NOT NULL DEFAULT 1,
  remaining_percent REAL NOT NULL DEFAULT 100,
  exit_price_usd REAL,
  exit_time INTEGER,
  pnl_percent REAL,
  exit_reason TEXT,
  signal_id INTEGER
);
```

Index:

```sql
CREATE INDEX IF NOT EXISTS idx_paper_trades_status
  ON paper_trades(status);
```

The DB also performs additive migration for paper execution/monitoring columns:

```text
last_price_usd
last_multiplier
last_pnl_percent
last_liquidity_usd
last_checked_at
observed_price_usd
estimated_fill_price_usd
estimated_slippage_bps
estimated_price_impact_bps
estimated_notional_usd
reference_sol_usd
comparison_notional_usd
comparison_slippage_bps
comparison_fill_price_usd
effective_liquidity_usd
liquidity_basis
liquidity_confidence
fill_model
fill_source
signal_first_seen_at
signal_last_seen_at
signal_created_at
first_wallet_to_fill_seconds
latest_wallet_to_fill_seconds
signal_to_fill_seconds
```

Semantics:

- There is at most one open trade per token. `openPaperTrade()` returns the existing open trade id if one exists.
- `entry_price_usd` is the paper fill price, not necessarily the raw observed market price.
- `observed_price_usd` records the market snapshot price used as reference.
- `estimated_fill_price_usd` records the simulated fill price after slippage/impact.
- `estimated_slippage_bps` and `estimated_price_impact_bps` make fill assumptions auditable.
- `comparison_*` fields record larger-notional comparison estimates for context.
- `effective_liquidity_usd`, `liquidity_basis`, and `liquidity_confidence` describe the liquidity input.
- `signal_*` timing fields show signal/fill latency.
- `remaining_percent` falls after partial take-profit events.
- `max_multiplier` tracks best observed multiplier while open.
- `status` is `open` or `closed`.
- `pnl_percent` is final PnL only after close.

Open-trade monitoring updates:

- `last_price_usd`
- `last_multiplier`
- `last_pnl_percent`
- `last_liquidity_usd`
- `last_checked_at`
- `max_multiplier`
- `remaining_percent`

Final close sets:

- `status='closed'`
- `exit_price_usd`
- `exit_time`
- `pnl_percent`
- `exit_reason`
- `remaining_percent=0`

## JSON fields

The repo intentionally stores some rich objects as JSON text in SQLite rather than normalizing every field.

### `signals.wallets_json`

Contains participating wallet summaries. Typical fields include:

- address
- label
- trust
- latest event data

This is used for reporting and wallet attribution.

### `signals.score_json`

Contains full `TokenScore`, including:

- token address/symbol
- market snapshot fields
- composite score
- pass/fail status
- fail reasons
- warnings
- scoring components

Keep this field backward-compatible where possible because old signals remain in the DB after code changes.

## Generated JSON reports

### Cielo discovery report

Default:

```text
data/cielo-wallet-discovery-report.json
```

Contains:

- generation timestamp
- candidate path
- output path
- whether apply mode was used
- whether Cielo API key was configured
- source fetch summaries
- candidates with evidence
- vetting results if `--apply` was used

### Wallet vetting report

Default:

```text
data/wallet-vetting-report.json
```

or when run from Cielo apply mode:

```text
data/cielo-wallet-vetting-report.json
```

Contains:

- generation timestamp
- candidate source file
- signature sample limit
- whether apply mode was used
- whether probation was included
- per-wallet metrics, decision, score, suggested trust, and reasons

### Candidate files

Default Cielo output:

```text
config/cielo-wallet-candidates.json
```

Default generic candidate input:

```text
config/wallet-candidates.json
```

These are JSON arrays of wallet candidate objects. They may include evidence metadata from discovery sources.

## Watchlist backup behavior

Watchlist mutation helpers should use backup/atomic write patterns rather than blind overwrites.

Expected backup directory:

```text
config/.wallet-backups/
```

Before reviewing or committing watchlist changes:

```bash
git diff -- config/watched-wallets.json
```

If a scheduled job changes the watchlist, its report should mention what changed and where the backup is.

## Time conventions

Most timestamps are Unix seconds, not milliseconds.

Examples:

- `wallet_events.timestamp`
- `wallet_events.created_at`
- `signals.created_at`
- `api_usage.created_at`
- `paper_trades.entry_time`
- `paper_trades.exit_time`
- paper trade signal timing columns

JavaScript `Date.now()` must be divided by 1000 and floored when writing these fields.

## Query examples

Use `sqlite3` only for ad-hoc inspection, not as the normal app API.

Recent signals:

```bash
sqlite3 data/memecoin-alpha.sqlite \
  "SELECT id, symbol, composite_score, pass, datetime(created_at,'unixepoch') FROM signals ORDER BY id DESC LIMIT 10;"
```

Open paper positions:

```bash
sqlite3 data/memecoin-alpha.sqlite \
  "SELECT id, symbol, entry_price_usd, last_price_usd, last_pnl_percent, remaining_percent FROM paper_trades WHERE status='open' ORDER BY id DESC;"
```

Recent API usage by provider:

```bash
sqlite3 data/memecoin-alpha.sqlite \
  "SELECT provider, COUNT(*), SUM(credits) FROM api_usage WHERE created_at >= strftime('%s','now','-24 hours') GROUP BY provider ORDER BY SUM(credits) DESC;"
```

Prefer app commands for normal operation:

```bash
npm run status
npm run report
npm run wallet-performance -- 20
```

## Schema-change guidelines

When changing schema:

1. Add fields additively when possible.
2. Preserve old DB compatibility.
3. Use `ALTER TABLE ... ADD COLUMN` only after checking existing columns.
4. Keep JSON fields tolerant of missing old properties.
5. Update tests.
6. Update this document and `docs/development.md`.
7. Do not require deleting `data/memecoin-alpha.sqlite` as a normal migration path.

## Data retention

There is no dedicated retention pruning in the current core DB schema. Over time, `wallet_events`, `signals`, `api_usage`, and `paper_trades` can grow.

Suggested operator practice:

- Keep DB on local disk with enough headroom.
- Back up DB before manual pruning.
- Do not prune recent `api_usage` if budget mode relies on 24h windows.
- Preserve closed paper trades if they are still used for wallet performance evidence.

## Privacy and safety

The DB should not contain API keys, Telegram tokens, private keys, or seed phrases. It may contain public wallet addresses, token addresses, labels, notes, and performance telemetry.

If sharing a DB or generated report externally:

- Assume watched-wallet lists reveal strategy research.
- Remove local hostnames/paths if sensitive.
- Confirm no accidental `.env` dump is embedded.
- Do not share Telegram chat IDs if not needed.
