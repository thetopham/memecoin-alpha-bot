# Wallet sourcing playbook

The bot is only as useful as the watched wallets. This playbook explains how wallets should enter the system, how to vet them, what trust/tier values mean, and when to promote/demote/archive.

## Principle

A wallet is not alpha just because it appears on a leaderboard.

Public wallet sources are candidate generators. The bot's paper ledger is the evidence layer. A wallet earns trust only after it repeatedly participates in passing signals that produce usable paper outcomes with realistic fill assumptions.

Do not put your own wallet in the active alpha set unless you intentionally want to monitor yourself. Your own wallet is not an external signal and can contaminate the research loop.

## Watchlist model

Active watchlist file:

```text
config/watched-wallets.json
```

Each wallet can have:

- `address`: Solana wallet address.
- `label`: operator-readable label.
- `trust`: numeric value, normally 0-1.
- `enabled`: false disables scanning.
- `tier`: `hot`, `probation`, `candidate`, or `archive`.
- `source`: where it came from.
- `notes`: why it is being watched or changed.
- timestamps such as `addedAt`, `lastTierChangeAt`, and `archivedAt`.

Active wallets are `enabled !== false` and `tier !== 'archive'`.

The active watchlist can be changed by:

- `npm run add-wallet -- ...`
- `npm run vet-wallets -- --apply ...`
- `npm run discover-wallets -- --apply ...`
- `npm run wallet-maintenance`
- continuous scanner maintenance when auto-add/rotation are enabled
- Hermes wallet scanner/maintainer automation

Always inspect watchlist diffs before committing:

```bash
git diff -- config/watched-wallets.json
```

## Practical trust levels

Suggested starting interpretation:

| Trust | Meaning |
| --- | --- |
| `0.3` | Noisy public lead / auto-added candidate. |
| `0.5` | Candidate passed basic RPC vetting. |
| `0.55` | Stronger candidate from vetting score >= 80. |
| `0.6` | Plausible manually reviewed public leaderboard wallet. |
| `0.8` | Manually reviewed and active with encouraging paper data. |
| `1.0` | Repeat paper performer with durable evidence. |

Trust is not currently a hard signal gate. It is stored in `weightedTrust` and used in wallet performance/rotation. Low-trust active wallets can still count toward a 2-wallet convergence signal, which is why candidate/probation tier design matters.

## Tiers

| Tier | Intended use | Scan cadence |
| --- | --- | --- |
| `hot` | Best current active set. | Fastest, default `HOT_WALLET_SCAN_INTERVAL_SECONDS`. |
| `probation` | Usable but not fully trusted; recovering or under evaluation. | Slower, default 600s. |
| `candidate` | Low-trust seed wallets, usually from Cielo/Dune/manual discovery. | Slowest, default 3600s. |
| `archive` | Disabled or out of budget. | Not scanned. |

Tier limits protect RPC budget:

```text
HOT_WALLET_LIMIT=75
PROBATION_WALLET_LIMIT=150
CANDIDATE_WALLET_LIMIT=500
```

Wallet rotation assigns tiers using alpha score, current trust, recommendations, and configured limits.

## Good wallet characteristics

Look for wallets that:

- buy before broad momentum is obvious;
- participate in multiple distinct winning tokens, not one lucky outlier;
- cut or exit losers rather than bag-holding everything;
- have an average hold time long enough for the bot to plausibly follow;
- buy sizes that are meaningful but not whale-distorting;
- show current activity in the last 24-72 hours;
- avoid obvious deployer, rugger, insider, exchange, LP, or MEV patterns;
- improve the paper signal set when combined with other watched wallets.

## Bad wallet characteristics

Demote, reject, or archive wallets that:

- produce repeated paper stop-losses;
- buy after pumps, not before;
- have mostly dust/noise events;
- trade too fast to follow;
- concentrate on one token only;
- are dominated by one historical outlier win;
- show no parsed sells, leaving exit behavior unknown;
- are exchange/router/aggregator/LP/deployer wallets;
- are mostly wash/bot/MEV spam;
- go stale after being added.

## Source hierarchy

Preferred input sources:

1. Cielo wallet discovery and tagged wallet feeds.
2. Cielo public lists and token-flow feeds from trending/pulse tokens.
3. Dune Pump.fun/PumpSwap realized-profit leaderboards.
4. Nansen/Solscan/GMGN-style smart-money pages, manually reviewed.
5. DexScreener trending tokens, then earliest buyer/profitable seller inspection.
6. Telegram/Discord call groups only as leads, never as truth.
7. Manual wallets from operator research.

Avoid adding wallets directly from social claims without on-chain vetting.

## Cielo workflow

Cielo surfaces used by this repo:

- Wallet Discovery app data, sorted/scored locally.
- API tagged wallets: `human_operated`, `gem_finder`, `high_win_rate`, `popular_wallet`.
- Public lists related to Solana/Pump/FOMO/trader/wallet tracking/GMGN.
- Trending and pulse tokens, then recent swap wallets from token feeds.

Useful web references:

- `https://app.cielo.finance/wallet-discovery`
- `https://docs.cielo.finance/guides/copy-trading/finding-good-wallets`

Cielo's own guidance is broadly aligned with this repo:

1. chain = Solana
2. sort/filter by realized PnL
3. check ROI
4. check win rate
5. prefer recent activity
6. prefer tags such as Human Operated, Gem Finder, High Winrate
7. manually inspect full trading history

Cielo Wallet Discovery may require a paid plan for full leaderboard access. API-backed sources require `CIELO_API_KEY` when those endpoints need authentication.

## Cielo discovery command

Candidate-file-only run:

```bash
npm run discover-wallets
```

Common options:

```bash
npm run discover-wallets -- --limit=60 --pages=2 --signatures=40
npm run discover-wallets -- --json
npm run discover-wallets -- --no-api
npm run discover-wallets -- --no-app
npm run discover-wallets -- --candidates=config/cielo-wallet-candidates.json
npm run discover-wallets -- --output=data/cielo-wallet-discovery-report.json
npm run discover-wallets -- --vet-report=data/cielo-wallet-vetting-report.json
```

Apply mode, which discovers, vets, and writes qualifying wallets to the active watchlist:

```bash
npm run discover-wallets -- --apply --signatures=40
```

Include probation candidates too, only if you intentionally want more noise:

```bash
npm run discover-wallets -- --apply --include-probation --signatures=40
```

Outputs:

```text
config/cielo-wallet-candidates.json
data/cielo-wallet-discovery-report.json
data/cielo-wallet-vetting-report.json   # when --apply is used
```

The discovery report records:

- generation time
- candidate path
- output path
- whether apply mode ran
- whether API key was configured
- source summaries
- candidates and Cielo evidence
- vetting counts/results when apply mode is used

## Cielo candidate scoring

Discovery rows are locally scored from Cielo-provided fields.

Positive signals include:

- realized PnL above `CIELO_MIN_PNL_USD`
- ROI above `CIELO_MIN_ROI_PERCENT`
- win rate above `CIELO_MIN_WINRATE_PERCENT`
- recent activity inside `CIELO_MAX_LAST_ACTIVE_HOURS`
- useful tags such as `human_operated`, `gem_finder`, `high_win_rate`, `popular_wallet`
- some SOL balance evidence

Negative/caution signals include:

- stale activity
- PnL/ROI/winrate below thresholds
- `sniper` tag
- trading bot label
- average hold time below 120 seconds

Rows below local threshold are discarded before writing candidates.

Default thresholds:

```text
CIELO_MIN_PNL_USD=500
CIELO_MIN_ROI_PERCENT=50
CIELO_MIN_WINRATE_PERCENT=45
CIELO_MAX_LAST_ACTIVE_HOURS=48
CIELO_MAX_CANDIDATES=60
CIELO_DISCOVERY_PAGES=2
CIELO_FEED_MIN_USD=25
CIELO_FEED_LOOKBACK_HOURS=24
```

## Candidate vetting workflow

Candidate file default:

```text
config/wallet-candidates.json
```

Cielo candidate file default:

```text
config/cielo-wallet-candidates.json
```

Read-only vetting:

```bash
npm run vet-wallets -- --signatures=40
```

Vetting a specific candidate file:

```bash
npm run vet-wallets -- config/cielo-wallet-candidates.json --signatures=40 --output=data/cielo-wallet-vetting-report.json
```

JSON output:

```bash
npm run vet-wallets -- config/cielo-wallet-candidates.json --json
```

Apply `keep` only:

```bash
npm run vet-wallets -- config/cielo-wallet-candidates.json --apply --signatures=40
```

Apply `keep` plus `probation`:

```bash
npm run vet-wallets -- config/cielo-wallet-candidates.json --apply --include-probation --signatures=40
```

Default report:

```text
data/wallet-vetting-report.json
```

## Vetting metrics

The vetter samples recent signatures through Solana RPC and parses supported swaps. It computes metrics including:

- signatures checked
- parsed swaps
- buys and sells
- distinct buy tokens
- total/average buy and sell SOL
- latest signature age
- latest parsed swap age
- sample span
- active trading streak days
- matched round trips
- average hold minutes
- token-level win rate and median PnL where inferable
- PnL outlier share
- recent losing/profitable streak
- zeroish/dust event rate
- recent buy count in 24h
- recent swap share in 48h
- parser sources and parse errors

Classification outputs:

- `keep`: active and broad enough to add with starter trust 0.50-0.55.
- `probation`: usable but thin/noisy; starter trust 0.30 if included.
- `reject`: inactive, too small/noisy, too stale, too narrow, no parsed swaps, or otherwise weak.

## Vetting keep/probation logic

A `keep` wallet generally needs:

- latest activity within 72h;
- at least 3 parsed swaps;
- at least 3 buys;
- at least 2 distinct buy tokens;
- average buy size at least 0.03 SOL;
- sell size usable if sells exist;
- hold time not too fast to follow;
- distribution not dominated by one outlier;
- current form not stale;
- dust/noise rate not too high;
- score at least 65.

A `probation` wallet generally needs:

- activity within 168h;
- at least 2 parsed swaps;
- at least 1 buy;
- at least 1 distinct buy token;
- average buy size at least 0.01 SOL;
- dust/noise rate not too high;
- score at least 45.

Do not assume probation is harmless. If active, it can contribute to a convergence signal.

## Manual wallet review checklist

Before manually adding a wallet:

1. Is it a normal wallet, not an exchange/router/aggregator/LP/deployer?
2. Is it active in the last 24-72 hours?
3. Does it buy before obvious momentum?
4. Does it sell or cut losses?
5. Is performance spread across several tokens?
6. Are buy sizes large enough to matter but small enough to follow?
7. Is average hold time compatible with polling/fill latency?
8. Does it avoid obvious sniper/wash/MEV behavior?
9. Does it add diversity to the existing watchlist?
10. Can we start it at low trust first?

Manual add:

```bash
npm run add-wallet -- <WALLET_ADDRESS> <label> 0.6
npm run wallets
git diff -- config/watched-wallets.json
```

## Auto-add and rotation

`wallet-maintenance` can do two separate things:

1. Candidate auto-add: read `CIELO_CANDIDATE_PATH` and insert bounded new candidate wallets.
2. Wallet rotation: use paper attribution to update trust/tier/enabled state.

Config controls:

```text
ENABLE_WALLET_CANDIDATE_AUTO_ADD=true
WALLET_CANDIDATE_AUTO_ADD_BATCH_LIMIT=25
ENABLE_WALLET_AUTO_ROTATION=true
WALLET_ROTATION_INTERVAL_SECONDS=3600
HOT_WALLET_LIMIT=75
PROBATION_WALLET_LIMIT=150
CANDIDATE_WALLET_LIMIT=500
```

Candidate auto-add behavior:

- Skips addresses already in the watchlist.
- Adds as `tier: candidate`.
- Enables the wallet.
- Caps trust at 0.35 or defaults to 0.3.
- Appends a cautionary note.
- Sets `addedAt` and `lastTierChangeAt`.

Rotation behavior:

- Computes wallet performance from recent signal/trade attribution.
- Applies suggested trust adjustments.
- Uses recommendations to prefer hot/probation/candidate/archive.
- Respects configured tier limits.
- Archives wallets outside the configured wallet budget.
- Archives persistent losers when recommendation is `disable_candidate`.

Force maintenance:

```bash
npm run wallet-maintenance
```

If you want manual-only control:

```text
ENABLE_WALLET_CANDIDATE_AUTO_ADD=false
ENABLE_WALLET_AUTO_ROTATION=false
```

## Promotion criteria

Promote a wallet toward hot/higher trust only after paper evidence shows:

- at least 3 closed paper trades with average PnL >= 15%;
- win rate >= 60%;
- no obvious fill-latency issue;
- signals were not all from one lucky token;
- no severe slippage/fill-confidence problem;
- behavior still active recently.

The automated recommendation rule is intentionally conservative: fewer than 2 closed trades is always `keep` / keep observing.

## Demotion/archive criteria

Demote or archive if:

- closed paper losses and weak win rate accumulate;
- average PnL <= -25% with win rate <= 25%;
- bad signal streak >= 2;
- average PnL is below 5% after at least 3 closed trades;
- at least 8 closed trades show avg PnL <= -20%, win rate <= 20%, and bad streak >= 4;
- wallet is stale or outside tier budget;
- manual review identifies bot/deployer/exchange/LP/noise behavior.

## Source-specific notes

### Dune / Pump.fun leaderboards

Useful for seed discovery because they surface realized-profit wallets. Risky because leaderboards can include:

- deployer or insider wallets;
- bots or snipers too fast to follow;
- wallets dominated by one lucky jackpot;
- market makers and LP wallets;
- wallets with stale historical performance.

Use Dune outputs as candidate files, then vet through RPC before adding.

### Solscan token-holder pages

Good for post-hoc research:

- Pick a recent winning token.
- Inspect earliest buyers and profitable sellers.
- Exclude deployer/team/LP/router wallets.
- Add candidates only after broader history review.

### DexScreener trending tokens

Good for finding active arenas:

- Identify trending Solana memecoins.
- Inspect early buyer clusters.
- Cross-check wallets across several tokens.
- Avoid adding wallets that only appear after tokens have already pumped.

### Telegram/Discord call groups

Treat only as noisy source discovery:

- Never add call-group wallets blindly.
- Do not trust claims without on-chain evidence.
- Watch for coordinated pump/distribution behavior.

## Review cadence

Suggested cadence:

Daily:

```bash
npm run report -- --refresh
npm run wallet-performance -- 20
```

Every few days:

```bash
npm run discover-wallets
npm run vet-wallets -- config/cielo-wallet-candidates.json --signatures=40
```

Weekly:

- Review hot wallet paper outcomes.
- Archive obvious losers/noise.
- Promote only repeat performers.
- Keep candidate pool bounded to protect API budget.
- Check that auto-rotation did not drift the watchlist into low-quality candidates.

## Commit guidance

Commit watchlist changes only when they are meaningful and reviewed.

Before commit:

```bash
git diff -- config/watched-wallets.json
git diff --stat
npm run wallets
```

Commit message examples:

```text
Update memecoin watchlist from Cielo vetting
Promote repeat paper performers in alpha watchlist
Archive stale candidate wallets
```

Do not commit `.env`, API keys, or provider dashboards exports containing secrets.
