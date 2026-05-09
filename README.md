# Memecoin Alpha Bot

Dry-run Solana memecoin alpha scanner and paper-trading ledger. It watches configured wallets, detects same-token buy convergence, scores the token, opens simulated positions only when the signal clears risk gates, and reports paper outcomes through the CLI, Telegram/log alerts, a local dashboard, and Hermes ops automation.

This project is intentionally **paper-only**. It does not need a wallet private key, does not store a private key, and does not execute Jupiter or other live swaps.

## What it does

1. Polls configured Solana wallets through Helius/Solana RPC.
2. Parses recent Pump.fun, Raydium, Jupiter, and Orca swap transactions.
3. Emits a convergence signal when `MIN_WALLETS_FOR_SIGNAL` watched wallets buy the same mint inside `SIGNAL_WINDOW_SECONDS`.
4. Enriches the mint with DexScreener and pump.fun market data.
5. Pulls top-holder concentration from Solana RPC.
6. Scores the token across volume, liquidity, holder distribution, short-window buy/sell velocity, and pair age.
7. Skips weak/risky tokens and records the skip reason.
8. Opens a paper trade for passing signals with a simulated fill, slippage estimate, and fill-latency metadata.
9. Updates open paper positions, applies staged take-profit inventory reduction, stop loss, trailing stop, and tracked-wallet sell exits.
10. Attributes signal/trade outcomes back to participating wallets so the watchlist can be promoted, probated, demoted, or archived.

## Current safety boundary

- `DRY_RUN=true` is mandatory. `loadConfig()` throws if it is false.
- No private-key path exists in v1.
- No live order routing or swap execution exists in v1.
- Telegram/log alerts, dashboard output, reports, and SQLite rows are market-intelligence/paper-trading artifacts, not financial advice.
- Do not add live execution without a separate explicit approval scope, burner-wallet design, loss caps, tests, and review.

## Quick start

```bash
cd /home/thetopham/memecoin-alpha-bot
npm install
cp .env.example .env
chmod 600 .env
# Fill HELIUS_API_KEY or SOLANA_RPC_URL in .env, then keep DRY_RUN=true.
npm test
npm run build
npm run wallets
npm run scan:once
npm run status
npm run report
```

A single watched wallet can collect events, but it cannot trigger a convergence signal. The default signal gate is 2 watched wallets buying the same mint inside 300 seconds.

## Common commands

```bash
npm run dev                       # continuous scanner via tsx
npm run start                     # compiled continuous scanner from dist/
npm run scan:once                 # one bounded scan; first run checkpoints without history
npm run scan:once -- --include-history
npm run status                    # local DB/watchlist status; no explicit market refresh
npm run status -- --refresh       # refresh open paper positions first
npm run report                    # status plus recent signals
npm run report -- --refresh       # refresh open paper positions first
npm run wallets                   # print normalized active watchlist
npm run add-wallet -- <ADDRESS> <label> 0.6
npm run wallet-performance -- 12
npm run wallet-maintenance        # force candidate sync/rotation
npm run discover-wallets          # Cielo candidate discovery
npm run vet-wallets -- --signatures=40
npm run dashboard -- --host 127.0.0.1 --port 8788
```

Build and test:

```bash
npm run lint
npm test
npm run build
```

## Dashboard

The dashboard is read-only. It reads local SQLite/watchlist state and does not call Helius, Solana RPC, Cielo, DexScreener, or pump.fun.

```bash
npm run dashboard -- --host 127.0.0.1 --port 8788
```

Binding to a LAN/non-loopback host requires `DASHBOARD_AUTH_TOKEN` unless `DASHBOARD_INSECURE=true` is intentionally accepted. Auth uses the `x-dashboard-token` header; query-string tokens are rejected so tokens do not leak into URLs or logs.

The current LAN deployment is documented in `docs/operations.md`.

## Configuration files

- `.env` — local secrets and runtime knobs. Never commit or print it.
- `.env.example` — documented environment template.
- `config/watched-wallets.json` — active watchlist plus tier/trust metadata.
- `config/cielo-wallet-candidates.json` — Cielo-discovered candidate wallets.
- `config/wallet-candidates.json` and `config/dune-wallet-candidates*.json` — manually collected candidate pools.
- `data/memecoin-alpha.sqlite` — SQLite ledger for state, events, signals, API usage, and paper trades.

## Documentation

Start here:

- `docs/index.md` — documentation map.
- `docs/architecture.md` — control flow, module map, data flow, and failure behavior.
- `docs/configuration.md` — environment variables, wallet schema, candidate files, and config-file behavior.
- `docs/data-model.md` — SQLite schema, generated JSON reports, runtime files, and retention/privacy notes.
- `docs/integrations.md` — Solana RPC/Helius, DexScreener, pump.fun fallback, Cielo, Telegram, dashboard, systemd, and Hermes surfaces.
- `docs/scoring-and-paper-trading.md` — signal detection, token scoring, simulated fills, exits, and wallet attribution.
- `docs/wallet-sourcing.md` — Cielo/Dune/manual wallet sourcing, vetting, trust tiers, and rotation.
- `docs/operations.md` — installation, services, dashboard, Hermes jobs, runbooks, and troubleshooting.
- `docs/safety.md` — dry-run boundary, secrets, dashboard/API budget guardrails, and live-trading non-goals.
- `docs/development.md` — repo layout, testing strategy, extension points, and contribution rules.
- `docs/hermes-integration.md` — Hermes prompts, cron boundaries, and operator expectations.
- `docs/repo-alpha-extraction.md` — how to turn external research/repos into safe paper-only improvements.

## Repository map

```text
src/                    TypeScript application code
  cli.ts                CLI command router
  orchestrator.ts       Main scanner loop and signal-processing pipeline
  walletTracker.ts      Wallet polling and checkpointing
  transactionParser.ts  Swap parser for supported Solana DEX programs
  signalDetector.ts     Same-token multi-wallet convergence detector
  tokenAnalyzer.ts      Market snapshot scoring and risk gates
  dexScreener.ts        DexScreener + pump.fun market data client
  holderAnalysis.ts     Top-10 holder concentration RPC helper
  paperTrader.ts        Paper entries, exits, and open-position updates
  fillSimulator.ts      Paper fill/slippage/latency estimation
  walletPerformance.ts  Signal/trade attribution back to wallets
  walletRotation.ts     Candidate sync and hot/probation/candidate rotation
  walletEvaluator.ts    Candidate-wallet RPC vetting CLI
  cielo*.ts             Cielo discovery/client integration
  db.ts                 SQLite schema and data-access layer
  dashboard.ts          Read-only HTTP dashboard
  reportFormatter.ts    CLI/dashboard report text helpers
  apiBudget.ts          Bot-logged Helius/API budget governor
  rateLimit.ts          Shared rate-limit/retry helpers
tests/                  Vitest unit/integration-style tests
config/                 Watchlist and candidate wallet JSON files
data/                   Local SQLite DB plus generated reports/screens
systemd/                User service templates
scripts/                Installer helpers
docs/                   Long-form documentation
```

## Default paper-trading assumptions

- Position size: `MAX_PAPER_POSITION_SOL=0.10`.
- SOL reference price for notional estimates: `PAPER_SOL_USD_FOR_ESTIMATES=90`.
- Comparison fill size: `PAPER_COMPARISON_NOTIONAL_USD=100`.
- Stop loss: `STOP_LOSS_PERCENT=-40`.
- Take-profit ladder: `2x -> 80% remaining`, `3x -> 50% remaining`, `5x -> 20% remaining`.
- Trailing stop: after `PAPER_TRAILING_STOP_ACTIVATION_MULTIPLE=1.5`, close remaining inventory on `PAPER_TRAILING_STOP_DRAWDOWN_PERCENT=30` drawdown from observed peak.

These are simulation rules, not a live trading strategy.

## Operational note

This repo is designed for cautious alpha research: data-first, skeptical, and dry-run by default. If a signal appears, the useful questions are "which wallets caused it, what risk gates passed, what would the simulated fill have looked like, and did the paper outcome validate those wallets?" not "should the bot ape this live?"
