# Repo alpha extraction notes

This document captures how to convert external memecoin research, public repositories, dashboards, and social-market observations into safe improvements for this repo without turning it into a live-trading system prematurely.

## Purpose

The repo is a dry-run alpha research loop:

1. collect wallet activity;
2. detect same-token wallet convergence;
3. score token risk/market conditions;
4. paper trade with explicit fill assumptions;
5. attribute outcomes back to wallets;
6. use evidence to adjust the watched wallet set.

External “alpha” should improve one of those steps. If it does not improve signal quality, fill realism, risk controls, wallet selection, or operational reliability, it is probably noise.

## Good extraction targets

Useful things to extract from public repos/articles/videos/dashboards:

- wallet sourcing heuristics;
- transaction parser patterns for Solana DEXs;
- token risk filters;
- liquidity/fill simulation ideas;
- slippage and price-impact models;
- wallet attribution metrics;
- scoring explainability patterns;
- operations/runbook practices;
- API rate-limit handling;
- dashboard visualization ideas that remain read-only.

Avoid extracting:

- private-key handling from unknown repos;
- hardcoded RPC/API keys;
- “guaranteed alpha” formulas without evidence;
- live trading snippets;
- opaque bundled dependencies;
- social-call automation that bypasses on-chain validation;
- untested contract interaction code.

## Evaluation checklist for external ideas

Before importing an idea, answer:

1. What failure mode does it reduce?
2. Which module owns it?
3. Is it read-only/paper-only?
4. Does it require a new secret or provider?
5. Does it increase API budget usage?
6. Can it be tested with fixtures/mocks?
7. Does it make paper results more realistic or just more optimistic?
8. Does it require docs/config updates?
9. Does it preserve the dashboard as API-neutral/read-only?
10. Does it avoid watchlist contamination?

## Mapping ideas to modules

| Idea type | Likely module(s) | Docs to update |
| --- | --- | --- |
| New wallet source | `cieloWalletDiscovery.ts`, `walletEvaluator.ts`, maybe a new source client | `wallet-sourcing.md`, `integrations.md`, `configuration.md` |
| New transaction pattern | `transactionParser.ts` | `development.md`, maybe `architecture.md` |
| New market provider | `dexScreener.ts` or new client | `integrations.md`, `configuration.md`, `scoring-and-paper-trading.md` |
| New token risk filter | `tokenAnalyzer.ts` | `scoring-and-paper-trading.md`, `.env.example` if configurable |
| New paper fill model | `fillSimulator.ts`, `paperTrader.ts`, `db.ts` if fields needed | `scoring-and-paper-trading.md`, `data-model.md` |
| New wallet scoring metric | `walletPerformance.ts`, `walletRotation.ts` | `wallet-sourcing.md`, `scoring-and-paper-trading.md` |
| New operations alert | Hermes script or `notifier.ts` | `operations.md`, `hermes-integration.md` |
| Dashboard visualization | `dashboard.ts` only | `operations.md`, `integrations.md` if auth/API surface changes |

## Import process

1. Create a short note describing the external idea and source.
2. Identify the module boundary.
3. Add tests first if behavior is clear.
4. Implement the minimal read-only/paper-only version.
5. Run `npm run lint`, `npm test`, and `npm run build`.
6. Update docs.
7. Run a bounded live check only if needed, e.g. `npm run scan:once`.
8. Inspect `git diff` for accidental secrets or watchlist changes.

## Parser extraction

When studying another Solana trading bot or parser:

- Extract only transaction-shape logic, not signing/execution code.
- Build small fixtures for the transaction shape.
- Prefer false negatives over false positives.
- Add tests for buy, sell, irrelevant tx, and ambiguous tx.
- Label the source correctly.
- Do not parse arbitrary transfers as token buys.

## Scoring extraction

When studying another token scoring/risk model:

- Separate hard gates from score contributions.
- Preserve human-readable fail reasons.
- Avoid optimism bias.
- Include liquidity/fill confidence.
- Do not overweight one metric such as volume or social mentions.
- Keep composite scores bounded and explainable.
- Consider historical comparability: changing weights changes interpretation of old scores.

## Wallet-source extraction

When using public leaderboards or wallet lists:

- Treat them as candidate generators only.
- Run RPC vetting before applying.
- Start low-trust/candidate-tier.
- Avoid deployer/exchange/router/LP wallets.
- Prefer repeated, recent, diverse profitability over one jackpot.
- Watch hold time; wallets that trade too fast are not followable.
- Let paper attribution promote/demote over time.

## Dashboard/UI extraction

Read-only dashboard ideas are welcome if they make operations easier.

Allowed:

- clearer health cards;
- paper position status;
- wallet tier summaries;
- signal skip/fail reason tables;
- API budget display;
- Hermes ops job status;
- links to local reports.

Avoid:

- dashboard buttons that mutate watchlist or config;
- dashboard-triggered scans that call external APIs;
- dashboard secret/config display;
- live buy/sell buttons;
- unauthenticated LAN controls.

## Live-trading extraction is out of scope

If an external repo includes live swap code, do not copy it into this repo as an incremental feature.

A live-trading branch would need a separate design covering:

- wallet/key storage;
- signer isolation;
- trade limits;
- max loss;
- routing;
- slippage;
- fees;
- failed transaction handling;
- manual approval;
- kill switch;
- audit logs;
- deployment rollback.

Until then, external live-trading code can inform a future design note only.

## Documentation expectations

Every non-trivial extracted idea should update at least one doc:

- architecture/runtime behavior: `architecture.md`
- config/env: `configuration.md`
- data/schema: `data-model.md`
- integrations/providers: `integrations.md`
- scoring/fill/exits: `scoring-and-paper-trading.md`
- wallet sourcing/vetting/rotation: `wallet-sourcing.md`
- operations/Hermes: `operations.md`, `hermes-integration.md`
- safety boundary: `safety.md`

## Anti-patterns

Do not let “alpha extraction” become:

- dashboard overengineering;
- blind wallet-list ingestion;
- social-call following;
- hidden live trading;
- threshold loosening to force more trades;
- API-budget blowups;
- undocumented config sprawl;
- vague “AI analysis” without on-chain evidence.

The best improvement is often making a skip/fail reason more accurate, not making the bot trade more often.
