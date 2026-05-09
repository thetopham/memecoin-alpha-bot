# Development guide

This guide is for changing the code safely. The project is a strict TypeScript/Node.js repo, designed to run on a Raspberry Pi-class host with local SQLite and no native npm database module.

## Project constraints

- Node.js >= 22.
- TypeScript strict mode.
- CommonJS output to `dist/`.
- Runtime DB uses Node 22 built-in `node:sqlite`.
- V1 is dry-run/paper-only.
- No private keys, live swaps, or order execution.
- External integrations must be read-only except Telegram notifications and local JSON/SQLite writes.
- Dashboard must remain read-only and API-neutral.
- Secrets must not be committed, logged, or documented.

## Repository layout

```text
src/                    application code
tests/                  Vitest tests
config/                 watched wallets and candidate JSON files
data/                   runtime SQLite DB and generated reports
docs/                   long-form documentation
systemd/                user service templates
scripts/                helper scripts
.env.example            placeholder env template
package.json            npm scripts and dependency metadata
tsconfig.json           TypeScript compiler config
```

Important generated/runtime paths:

```text
dist/                         build output
data/memecoin-alpha.sqlite    SQLite DB
config/.wallet-backups/       watchlist backups
```

## Build and test commands

```bash
npm run lint     # tsc --noEmit
npm test         # vitest run
npm run build    # compile to dist/
```

Useful app commands during development:

```bash
npm run scan:once
npm run scan:once -- --include-history
npm run status
npm run status -- --refresh
npm run report
npm run report -- --refresh
npm run wallets
npm run wallet-performance -- 12
npm run dashboard -- --host 127.0.0.1 --port 8788
```

## TypeScript config

`tsconfig.json` uses:

- target: `ES2022`
- module: `CommonJS`
- rootDir: `src`
- outDir: `dist`
- strict mode enabled
- tests excluded from build output

Build output is for runtime services. Do not edit `dist/` manually.

## Dependency policy

Current dependencies are intentionally small:

Runtime:

- `dotenv`
- `ws`

Dev:

- `@types/node`
- `@types/ws`
- `tsx`
- `typescript`
- `vitest`

Before adding dependencies, ask:

1. Is this needed at runtime or only tests/scripts?
2. Does it compile/run on Raspberry Pi aarch64?
3. Does it require native modules?
4. Can Node 22 built-ins handle it?
5. Does it introduce a secret/config surface?
6. Does it increase service fragility?

## Tests

Existing test coverage includes:

- `tests/apiBudget.test.ts`
- `tests/config.test.ts`
- `tests/dashboard.test.ts`
- `tests/db.test.ts`
- `tests/dexScreener.test.ts`
- `tests/fillSimulator.test.ts`
- `tests/orchestrator.test.ts`
- `tests/paperTrader.test.ts`
- `tests/reportFormatter.test.ts`
- `tests/rpc.test.ts`
- `tests/signalDetector.test.ts`
- `tests/signalRetryQueue.test.ts`
- `tests/tokenAnalyzer.test.ts`
- `tests/transactionParser.test.ts`
- `tests/walletEvaluator.test.ts`
- `tests/walletPerformance.test.ts`
- `tests/walletRotation.test.ts`
- `tests/walletTracker.test.ts`
- `tests/wallets.test.ts`

When changing behavior, add or update tests close to the module being changed.

## Safe change workflow

Before editing:

```bash
cd /home/thetopham/memecoin-alpha-bot
git status --short
```

If `config/watched-wallets.json` is modified, treat it as existing operator state. Do not overwrite it unless the task is explicitly about the watchlist.

For code changes:

```bash
npm run lint
npm test
npm run build
```

For docs-only changes:

```bash
git diff -- README.md docs
```

For behavior changes that affect runtime flows:

```bash
npm run lint
npm test
npm run build
npm run scan:once
npm run status
```

If services run compiled code, restart after build:

```bash
systemctl --user restart memecoin-alpha-bot.service
systemctl --user restart memecoin-alpha-dashboard.service
```

## Module boundaries

### `config.ts`

Owns environment parsing, default values, bounds, path resolution, and the dry-run guard.

When adding config:

- Add type field in `types.ts`.
- Parse in `config.ts` with sane bounds.
- Add placeholder/comment to `.env.example` if operator-facing.
- Document in `docs/configuration.md`.
- Add/update `tests/config.test.ts`.

Never add config for private keys without a separate approved live-trading design.

### `db.ts`

Owns SQLite schema and data access.

When adding DB fields:

- Prefer additive migrations.
- Keep old DBs compatible.
- Add columns through an `ensure...Columns()` pattern when practical.
- Add tests in `tests/db.test.ts` or module-specific tests.
- Document schema changes in `docs/configuration.md`.

Because SQLite uses WAL mode, runtime files may include `-wal` and `-shm` sidecars.

### `walletTracker.ts`

Owns polling, checkpointing, tier scan intervals, and per-wallet resilience.

Be careful with:

- first-run behavior;
- when checkpoints advance;
- preserving retry behavior when parsed transactions are temporarily unavailable;
- API budget estimates;
- scan interval gating.

Test with `tests/walletTracker.test.ts`.

### `transactionParser.ts`

Owns transaction-shape interpretation.

Parser rules:

- Prefer false negatives over false positives.
- Do not invent token buys from ambiguous transactions.
- Preserve source classification: Pump.fun, Raydium, Jupiter, Orca, or unknown.
- Add fixtures/tests for new DEX formats.

Test with `tests/transactionParser.test.ts`.

### `signalDetector.ts`

Owns in-memory convergence detection.

Be careful with:

- unique-wallet dedupe;
- event timestamp ordering;
- duplicate emit suppression;
- updates to wallet metadata/trust;
- min wallet/window config behavior.

Test with `tests/signalDetector.test.ts`.

### `tokenAnalyzer.ts`

Owns scoring formula and hard/warning gates.

When changing score weights or thresholds:

- Update tests.
- Update `docs/scoring-and-paper-trading.md`.
- Consider how the change impacts historical comparability.
- Prefer making thresholds explicit config only when there is a real operator need.

### `dexScreener.ts`

Owns market snapshots from DexScreener and pump.fun fallback.

Be careful with:

- rate limits;
- timeouts/retries;
- cache TTL;
- fallback behavior;
- recognizing pre-graduation pump.fun tokens;
- avoiding hard crashes when a provider shape changes.

Test with `tests/dexScreener.test.ts`.

### `holderAnalysis.ts`

Owns top-10 holder percentage.

It uses Solana RPC token supply/largest accounts. If provider methods change or nulls appear, return null rather than blocking all signals unless the risk policy changes.

### `paperTrader.ts`

Owns paper entry and exits.

Be careful with:

- using estimated fill, not observed price, for entry;
- preserving partial take-profit semantics;
- not treating paper exits as live exits;
- notifier calls;
- tracked-wallet sell emergency exit window.

Test with `tests/paperTrader.test.ts`.

### `fillSimulator.ts`

Owns paper execution/slippage estimates.

This is intentionally approximate. If changing model:

- Keep the old fields meaningful.
- Include model name changes if semantics change.
- Test high/low/unknown liquidity cases.
- Update `docs/scoring-and-paper-trading.md`.

### `walletPerformance.ts`

Owns attribution and wallet recommendation logic.

Be careful with:

- deduplicating wallet participation per signal;
- open exposure calculation;
- bad signal streak order;
- trust recommendation bounds;
- keeping recommendations conservative with thin sample sizes.

### `walletRotation.ts`

Owns tier assignment and watchlist mutation helpers.

When changing:

- Preserve backup/atomic write behavior via `wallets.ts`.
- Do not make candidate wallets too trusted by default.
- Keep archive behavior explicit.
- Test tier-limit edge cases.

### `walletEvaluator.ts`

Owns candidate vetting from RPC samples.

When changing scoring:

- Keep reasons human-readable.
- Prefer rejecting ambiguous/noisy wallets.
- Update `wallet-sourcing.md`.
- Ensure `--apply` only writes intended decisions.

### `cieloWalletDiscovery.ts` and `cieloClient.ts`

Own Cielo discovery and API interaction.

When changing:

- Keep API keys in `.env` only.
- Make source errors non-fatal where possible.
- Keep candidate reports auditable.
- Do not let discovery write active watchlist unless `--apply` or maintenance is explicitly used.

### `apiBudget.ts`

Owns local request accounting and scan gating.

When changing:

- Preserve normal/conserve/emergency semantics unless docs/tests are updated.
- Candidate scans should remain the first thing paused under conservation.
- Remember local logs are estimates, not provider truth.

### `dashboard.ts`

Owns dashboard HTML/API view.

Rules:

- Keep it read-only.
- Do not add Helius/Cielo/DexScreener/pump.fun calls.
- Do not add watchlist mutation endpoints.
- Preserve non-loopback auth guard.
- Preserve header-only token behavior.
- Avoid leaking secrets in HTML/JSON.

Test with `tests/dashboard.test.ts`.

### `notifier.ts`

Owns Telegram/log alert behavior.

Rules:

- Missing Telegram config should fall back to log-only alerts.
- Do not print bot tokens.
- Keep rate limiting/retry behavior conservative.

## Adding a new DEX/source parser

Recommended process:

1. Capture sanitized transaction examples or build minimal fixtures.
2. Add parser support in `transactionParser.ts`.
3. Add tests for buy, sell, irrelevant transaction, and ambiguous transaction.
4. Confirm source is included in `SwapSource` if a new source enum is needed.
5. Update docs if the source becomes operator-visible.
6. Run `npm test -- transactionParser` if using Vitest filters, then full `npm test`.

Do not parse ambiguous transfers as buys just to increase event volume.

## Adding a new market-data provider

Recommended process:

1. Add a small client module or extend `dexScreener.ts` only if it remains cohesive.
2. Use `fetchWithTimeoutAndRetry()` and an `AsyncRateLimiter`.
3. Normalize into `TokenMarketSnapshot`.
4. Make provider failures degrade to null/fallback where safe.
5. Add tests with mocked fetch.
6. Document fields and fallback behavior.
7. Do not call new provider from dashboard.

## Adding a new scoring dimension

Recommended process:

1. Add field(s) to `TokenMarketSnapshot` if needed.
2. Update score formula in `tokenAnalyzer.ts`.
3. Add tests for pass/fail/warning behavior.
4. Decide if historical scores become incomparable; mention in docs if so.
5. Update `docs/scoring-and-paper-trading.md`.
6. Keep composite bounded 0-100.

## Adding live trading: explicit non-goal

Do not add live trading as an incremental convenience.

A live trading design would require a separate explicit scope including:

- burner wallet setup;
- private key storage design;
- order-routing provider choice;
- max daily loss and max position caps;
- dry-run/live split;
- kill switch;
- audit logs;
- integration tests;
- manual approval boundary;
- deployment rollback;
- security review.

Until then, leave `DRY_RUN=true` and keep this repo paper-only.

## Documentation maintenance

When changing behavior, update docs in the same change:

| Changed area | Docs to update |
| --- | --- |
| CLI commands | `README.md`, `operations.md` |
| Config/env | `.env.example`, `configuration.md` |
| Scoring/exits/fill model | `scoring-and-paper-trading.md` |
| Wallet source/vetting/rotation | `wallet-sourcing.md` |
| Dashboard behavior/auth | `operations.md`, `configuration.md`, maybe `architecture.md` |
| Hermes jobs/boundaries | `hermes-integration.md`, `operations.md` |
| Architecture/module flow | `architecture.md` |

Docs should use placeholders for secrets and should not include local `.env` values.

## Pre-commit checklist

```bash
git status --short
npm run lint
npm test
npm run build
git diff --stat
```

Then inspect any operational files:

```bash
git diff -- config/watched-wallets.json
```

If the change is docs-only, tests/build may be optional in a hurry, but link/reference checks and `git diff` are still required before reporting completion.
