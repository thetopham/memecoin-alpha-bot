# Architecture

This document explains the runtime architecture of the memecoin alpha bot: what each module owns, how a scan flows through the system, where data is persisted, and what failure modes are intentionally handled.

## High-level shape

The app is a TypeScript/Node.js command-line service with four major loops:

1. Wallet polling: read recent Solana signatures for watched wallets through RPC.
2. Signal detection: parse swaps and detect multi-wallet convergence on the same mint.
3. Signal evaluation: score the mint using market, holder, and flow data.
4. Paper lifecycle: open/update/close simulated trades and attribute outcomes back to wallets.

Everything persistent is local-first:

- Runtime state and ledgers live in SQLite.
- Wallet lists and candidates live in JSON files under `config/`.
- Reports are local text/JSON outputs or Telegram/log notifications.
- The dashboard reads only SQLite and JSON state.

There is no live order execution path.

## Main module map

| File | Responsibility |
| --- | --- |
| `src/cli.ts` | Parses CLI commands and routes to orchestrator, dashboard, wallet tools, discovery, or reports. |
| `src/config.ts` | Loads `.env`, applies defaults/bounds, resolves file paths, and enforces `DRY_RUN=true`. |
| `src/types.ts` | Shared domain types for wallets, swaps, signals, token snapshots, scores, config, execution estimates, and paper trades. |
| `src/orchestrator.ts` | Main runtime coordinator: maintenance, scanning, signal processing, position updates, status/report text. |
| `src/db.ts` | SQLite schema, migrations for paper trade columns, inserts/queries/stats/wallet attribution. |
| `src/wallets.ts` | Reads, normalizes, lists, adds, and writes watched wallets. |
| `src/walletTracker.ts` | Polls Solana signatures, handles checkpoints and tier intervals, fetches parsed txs, returns swap events. |
| `src/transactionParser.ts` | Extracts buy/sell swap events from supported Solana transaction shapes. |
| `src/signalDetector.ts` | Detects same-token buy convergence across unique wallets within a time window. |
| `src/signalRetryQueue.ts` | Retries signals when market data is temporarily unavailable. |
| `src/tokenAnalyzer.ts` | Builds a `TokenScore` from market snapshot, holder concentration, liquidity, volume, velocity, and age. |
| `src/dexScreener.ts` | Read-only DexScreener and pump.fun snapshot client. |
| `src/holderAnalysis.ts` | Computes top-10 holder concentration from Solana RPC token-account data. |
| `src/paperTrader.ts` | Opens paper trades from passing signals and updates exits/stops. |
| `src/fillSimulator.ts` | Estimates entry fill price, slippage, price impact, liquidity confidence, and timing latency. |
| `src/walletPerformance.ts` | Attributes signal/trade outcomes back to wallets and computes recommendations. |
| `src/walletRotation.ts` | Syncs candidates into the watchlist and rotates wallets across hot/probation/candidate/archive tiers. |
| `src/walletEvaluator.ts` | CLI candidate-screening workflow using recent RPC signatures and parsed swaps. |
| `src/cieloClient.ts` | Cielo API wrapper. |
| `src/cieloWalletDiscovery.ts` | Cielo discovery workflow and candidate/report writer. |
| `src/apiBudget.ts` | Bot-logged API budget accounting and tier gating. |
| `src/rpc.ts` | Solana RPC wrapper with timeout, retries, pacing, and API usage hooks. |
| `src/rateLimit.ts` | Generic async rate limiter and fetch-with-retry helper. |
| `src/notifier.ts` | Telegram or log-only alerts. |
| `src/dashboard.ts` | Read-only HTML/API dashboard over local state. |
| `src/reportFormatter.ts` | CLI/dashboard text formatting for paper portfolio, signals, exits, and wallet performance. |
| `src/utils.ts` | Formatting, numeric, address, time, and small collection helpers. |

## CLI commands and entry points

Defined in `package.json`:

| npm script | Command | Purpose |
| --- | --- | --- |
| `npm run dev` | `tsx src/cli.ts run` | Continuous scanner in TypeScript dev mode. |
| `npm run start` | `node dist/cli.js run` | Continuous scanner from compiled JS. |
| `npm run scan:once` | `tsx src/cli.ts scan-once` | One bounded scan, then exit. |
| `npm run status` | `tsx src/cli.ts status` | Print local state, portfolio, and wallet performance. |
| `npm run report` | `tsx src/cli.ts report` | Status plus recent signal details. |
| `npm run dashboard` | `tsx src/cli.ts dashboard` | Start read-only dashboard. |
| `npm run dashboard:dist` | `node dist/cli.js dashboard` | Dashboard from compiled JS. |
| `npm run wallets` | `tsx src/cli.ts wallets` | Print normalized active watchlist. |
| `npm run add-wallet -- <address> <label> <trust>` | `tsx src/cli.ts add-wallet ...` | Add/update a wallet in `config/watched-wallets.json`. |
| `npm run wallet-performance -- <limit>` | `tsx src/cli.ts wallet-performance ...` | Print wallet attribution summary. |
| `npm run wallet-maintenance` | `tsx src/cli.ts wallet-maintenance` | Force candidate sync and tier rotation. |
| `npm run discover-wallets` | `tsx src/cieloWalletDiscovery.ts` | Run Cielo discovery. |
| `npm run vet-wallets` | `tsx src/walletEvaluator.ts` | Screen candidate wallets through RPC parsing. |
| `npm run lint` | `tsc -p tsconfig.json --noEmit` | TypeScript strict compile check without output. |
| `npm test` | `vitest run` | Run tests. |
| `npm run build` | `tsc -p tsconfig.json` | Compile to `dist/`. |

## Continuous runtime flow

`npm run dev` or `npm run start` calls `Orchestrator.run()`.

Startup:

1. `loadConfig()` reads `.env`, applies defaults and bounds, resolves paths, and throws unless `DRY_RUN=true`.
2. `AlphaDb` opens the SQLite DB, enables WAL mode, creates tables, and applies additive paper-trade columns.
3. `loadWallets()` reads the watchlist and excludes disabled/archive wallets.
4. Runtime settings are printed: dry-run mode, DB path, poll interval, signature limits, RPC pacing, API budget status, wallet tier limits, and signal threshold.
5. The orchestrator immediately runs an initial scan.
6. A recurring scan timer runs every `POLL_INTERVAL_SECONDS`.
7. A separate position-update timer runs at `max(60s, POLL_INTERVAL_SECONDS * 2)`.

The orchestrator guards against overlap:

- If a scan is still running, the next scan is skipped.
- If a position update is running or a scan is running, another position update is skipped.
- Wallet maintenance has its own in-progress guard.

## One scan in detail

`Orchestrator.scanOnce(includeHistory)` does this:

1. Attempts `maintainWallets(false)`.
   - Candidate sync and rotation are skipped if the configured maintenance interval has not elapsed.
   - Any maintenance error is logged as a warning and scanning continues.
2. Reloads the active watched wallets.
3. Updates the signal detector with current wallet metadata.
4. Exits early if there are no active wallets.
5. Calls `PollingWalletTracker.pollAll(wallets, includeHistory)`.
6. Inserts each returned event into SQLite with `db.insertEvent()`.
   - Duplicate `tx_hash` rows are ignored.
7. For each inserted event:
   - Sell events go through tracked-wallet emergency-exit logic.
   - Buy events go through convergence detection and possible signal processing.
8. Processes retry-queued signals whose retry delay has elapsed.
9. Updates open paper positions.
10. Returns event counts: total, buys, sells.

## Wallet polling and checkpoints

The tracker stores two important state keys per wallet in SQLite:

- `last_signature:<wallet>` — the latest processed signature checkpoint.
- `last_wallet_scan:<wallet>` — the last successful scan timestamp.

Polling behavior:

- Disabled wallets and archive-tier wallets are skipped.
- Hot/probation/candidate wallets can have different scan intervals.
- API-budget decisions can skip low-priority tiers.
- If no checkpoint exists and `includeHistory=false`, the tracker records the newest signature and processes no historical transactions. This avoids stale first-run alerts.
- If `includeHistory=true`, the tracker can process a bounded historical window.
- If a parsed transaction is unavailable or parsing throws, the checkpoint is left unchanged so the next run can retry.
- If the old checkpoint cannot be found within `WALLET_SIGNATURE_MAX_PAGES`, the tracker processes a bounded catch-up window and logs a warning.

Credit estimate per wallet scan:

- One credit-like unit per signature page plus one per parsed transaction attempt.
- Estimated credits are used by `ApiBudgetManager.allowTier()` before scanning a wallet.

## Swap parsing

`transactionParser.ts` turns supported Solana transactions into normalized `WalletSwapEvent` records:

- `direction`: `buy` or `sell`.
- `source`: `pumpfun`, `raydium`, `jupiter`, `orca`, or `unknown`.
- `wallet`: watched wallet address.
- `tokenAddress`: mint address.
- `tokenSymbol`: optional symbol if available from parsed data.
- `solAmount`: SOL amount estimate.
- `txHash`: transaction signature.
- `timestamp`: block time or current time fallback.

Only normalized events are stored. Unsupported transaction shapes are ignored rather than guessed into signals.

## Signal detection

`SignalDetector.onBuyEvent()` handles only buy events.

For each token:

1. Keeps buy events inside `SIGNAL_WINDOW_SECONDS` relative to the current event timestamp.
2. Deduplicates by wallet, keeping the latest buy per wallet.
3. Requires at least `MIN_WALLETS_FOR_SIGNAL` unique wallets.
4. Builds a `ConvergenceSignal` sorted by wallet buy time.
5. Sums wallet trust into `weightedTrust`.
6. Records `firstSeen`, `lastSeen`, observed window width, and unique sources.
7. Suppresses duplicate emits for the same token inside the signal window.

The orchestrator also checks SQLite with `hasRecentSignal(token, cutoff)` before scoring to avoid duplicate persisted signals in the same recent window.

## Signal scoring and retry

`processSignal()` does this:

1. Skips if a recent signal already exists for the token.
2. Calls `TokenAnalyzer.score(tokenAddress)`.
3. If scoring throws or no market data is available, returns `false` so the signal goes into `SignalRetryQueue`.
4. The retry queue uses bounded delays of 30s, 90s, 180s, and 480s.
5. If a score exists, the signal is inserted into SQLite with pass/fail status.
6. A token passes only when:
   - `score.pass` is true, meaning no hard fail reasons; and
   - `score.composite >= MIN_COMPOSITE_SCORE`.
7. Failing tokens are logged with reasons and warnings.
8. Passing tokens open a paper trade and trigger a notifier signal alert.

See `scoring-and-paper-trading.md` for the scoring formula and exit rules.

## Paper trade lifecycle

When a signal passes:

1. `PaperTrader.openFromSignal()` reads the observed price from the score snapshot.
2. `estimatePaperExecution()` estimates slippage/fill details using configured SOL size and liquidity basis.
3. The DB records an open `paper_trades` row with signal linkage and execution metadata.

During position updates:

1. DexScreener/pump.fun market data is refreshed for each open trade.
2. The current multiplier and PnL are calculated from current price vs entry price.
3. `max_multiplier`, `remaining_percent`, last price, last liquidity, and last check time are updated.
4. Take-profit levels reduce simulated remaining inventory.
5. Trailing stop and stop loss can close the remaining paper trade.
6. If two tracked wallets sell the same token inside the exit window, `emergencyExit()` can close the paper trade.

## Wallet maintenance flow

`maintainWallets(force)` manages the watchlist as operational state:

1. It returns immediately if both auto-rotation and candidate auto-add are disabled.
2. Unless forced, it respects `WALLET_ROTATION_INTERVAL_SECONDS` via SQLite state key `last_wallet_maintenance`.
3. If candidate auto-add is enabled, it reads `CIELO_CANDIDATE_PATH` and syncs bounded candidates into the watched wallet file.
4. If auto-rotation is enabled, it computes wallet performance over recent signal/trade attribution and applies tier changes.
5. If changes occurred, `writeWalletFile()` writes the updated JSON and creates a backup path.
6. The active wallet count excludes disabled and archive wallets.

This is the main workflow that can mutate `config/watched-wallets.json` without a human directly editing it.

## API clients and budget governor

External reads:

- Solana/Helius RPC: signatures, parsed transactions, token largest accounts, token supply.
- DexScreener: token/pair market snapshots.
- pump.fun: fallback/pre-graduation market snapshots where available.
- Cielo: wallet discovery and wallet feed/profile data when discovery is run.
- Telegram: optional outbound alert API.

The RPC client defaults are intentionally conservative:

- Timeout: 15 seconds.
- Max retries: 5.
- Retry backoff base/max: 1s / 30s.
- Min interval: 125ms by default, pacing below common free-tier RPC limits.

`ApiBudgetManager` tracks bot-logged credits in SQLite. It has three modes:

- `normal`: below soft daily credits.
- `conserve`: at or above soft daily credits.
- `emergency`: at or above hard daily credits.

Tier gating behavior:

- Archive scans are refused.
- Any scan is refused when hard daily budget is already exceeded.
- In emergency mode, all tiers are refused.
- In conserve mode, candidate scans are paused first.

Budget status is printed in startup/status output as a compact line like:

```text
helius: normal | bot-logged 24h ...
```

The budget is based on this bot's own logged requests, not on the provider's authoritative account dashboard.

## Dashboard architecture

`src/dashboard.ts` serves:

- `/` — HTML dashboard.
- `/api/dashboard` — JSON view model.

Important properties:

- It opens SQLite read-only from the app perspective but through the normal `AlphaDb` class.
- It reads local watchlist and SQLite state.
- It does not call Helius, Solana RPC, Cielo, DexScreener, or pump.fun.
- It includes paper portfolio, open/closed positions, recent signals, wallet performance, API budget status, and Hermes ops job metadata.
- It enforces dashboard auth for non-loopback hosts unless `DASHBOARD_INSECURE=true` is deliberately set.
- Tokens must be sent in the `x-dashboard-token` header; query-string tokens are not supported.

## Persistence model

SQLite tables:

- `state`: key/value runtime checkpoints and maintenance timestamps.
- `wallet_events`: normalized swap events keyed by transaction hash.
- `signals`: persisted convergence signals and scoring result JSON.
- `api_usage`: bot-logged request/credit accounting.
- `paper_trades`: open and closed paper position lifecycle plus execution/fill metadata.

SQLite pragmas:

- `busy_timeout = 5000`.
- `journal_mode = WAL`.
- `synchronous = NORMAL`.

See `configuration.md` for schema details and field meanings.

## Failure behavior

The app generally prefers bounded degradation over crashing the whole process:

- Wallet maintenance failure before scan logs a warning and scanning continues.
- Per-wallet polling failure logs a warning and moves to the next wallet.
- Unavailable parsed transactions preserve the old checkpoint for retry.
- Missing market data puts a signal into retry queue rather than immediately skipping it.
- Duplicate transaction hashes are ignored by DB primary key.
- Dashboard refuses unsafe LAN binding unless protected or explicitly insecure.
- `loadConfig()` fails fast if live trading is attempted via `DRY_RUN=false`.

## Non-goals in v1

The current architecture intentionally excludes:

- Live swap execution.
- Private key management.
- Automated position sizing beyond fixed paper size.
- Order-book or mempool-level execution modeling.
- Twitter/CT sentiment scanning beyond placeholder config.
- External dashboard writes/actions.
- Treating any public wallet list as automatically trustworthy.
