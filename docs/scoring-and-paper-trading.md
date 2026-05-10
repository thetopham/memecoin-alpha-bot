# Scoring and paper trading

This document describes how the bot turns wallet activity into a signal, how it scores the token, how simulated entries/exits work, and how the results feed back into wallet trust.

## Core idea

The bot is not trying to predict every memecoin move. It is testing whether a specific watched-wallet set produces usable early signals.

The main research loop is:

1. A watched wallet buys a token.
2. Another watched wallet buys the same token soon after.
3. The token clears risk and quality gates.
4. A paper trade is opened with an estimated fill price.
5. The paper trade is monitored until closed.
6. Participating wallets get performance credit/blame.
7. Wallet tiers and trust can be updated based on that evidence.

## Event inputs

A normalized event has:

- wallet address
- token mint address
- optional token symbol
- direction: `buy` or `sell`
- estimated SOL amount
- transaction signature
- unix timestamp
- source: `pumpfun`, `raydium`, `jupiter`, `orca`, or `unknown`

Events are produced only when the parser can normalize a transaction into a plausible swap. Unknown or unsupported transaction shapes are ignored rather than forced into the model.

## Signal detection

A signal is same-token buy convergence across unique watched wallets.

Required conditions:

- The event direction is `buy`.
- At least `MIN_WALLETS_FOR_SIGNAL` unique wallets have bought the same token.
- The buys occur inside `SIGNAL_WINDOW_SECONDS`.
- The token has not already emitted a signal inside the current signal window.
- SQLite does not already have a recent signal for the token inside the same cutoff.

Default gate from `.env.example`:

```text
MIN_WALLETS_FOR_SIGNAL=2
SIGNAL_WINDOW_SECONDS=300
```

Signal fields:

- `tokenAddress`: mint.
- `wallets`: latest buy event per wallet, sorted oldest to newest.
- `walletCount`: unique wallet count.
- `weightedTrust`: sum of wallet trust values.
- `windowSeconds`: `lastSeen - firstSeen`.
- `firstSeen`: timestamp of first participating buy.
- `lastSeen`: timestamp of last participating buy.
- `sources`: unique swap sources among participating buys.

Important nuance: `weightedTrust` is stored and displayed, but the current pass/fail path is controlled by token score and hard gates, not by a separate weighted-trust threshold.

## Market snapshot sources

`TokenAnalyzer.score()` asks for:

1. Top-10 holder concentration from Solana RPC.
2. Best market snapshot from DexScreener, with pump.fun fallback when no Solana DEX pair is available or the DexScreener fetch fails.

Snapshot fields used for scoring include:

- symbol/name
- price USD
- DEX/pair URL when available
- liquidity USD and liquidity status
- market stage: `dex_pool`, `pumpfun_bonding_curve`, or `unknown`
- 24h and 1h volume
- 5m buy/sell transaction counts
- 1h buy/sell transaction counts
- pair/token age in minutes
- top-10 holder percentage
- market cap / FDV where available
- pump.fun holder count / bonding curve progress where available

DexScreener behavior:

- Rate-limited at 200ms between requests.
- Uses a 15s in-process snapshot cache keyed by token and holder concentration.
- Sorts Solana pairs by liquidity, volume, and short-window transactions.
- Uses the highest-ranked Solana pair.

pump.fun fallback behavior:

- Rate-limited at 500ms between requests.
- Fetches coin and metadata endpoints when available.
- Marks active pre-graduation tokens as `pumpfun_bonding_curve` with DEX liquidity unavailable.
- Estimates 1h and 5m volume/transactions from total activity and token age when needed.

## Token scoring formula

The composite score is 0-100:

```text
composite =
  volume       * 0.25 +
  liquidity    * 0.20 +
  distribution * 0.30 +
  velocity     * 0.15 +
  age          * 0.10
```

The score is rounded to the nearest integer.

A token opens a paper trade only if:

1. There are no hard fail reasons; and
2. `composite >= MIN_COMPOSITE_SCORE`.

Default min score:

```text
MIN_COMPOSITE_SCORE=60
```

## Volume score

Inputs:

- 24h volume USD
- 1h volume USD

24h score:

| 24h volume | Score |
| --- | --- |
| `< $10k` | 20 |
| `$10k - $50k` | 45 |
| `$50k - $250k` | 75 |
| `>= $250k` | 95 |

1h score:

| 1h volume | Score |
| --- | --- |
| `< $2k` | 20 |
| `$2k - $10k` | 50 |
| `$10k - $50k` | 80 |
| `>= $50k` | 95 |

Combined:

```text
volume = round(24h_score * 0.65 + 1h_score * 0.35)
```

Hard fail:

- If 24h volume `< $5k` and 1h volume `< $1k`, add `volume too low to trust signal`.

## Liquidity score and liquidity gate

Inputs:

- DEX liquidity USD, or
- pump.fun bonding-curve/pre-graduation status.

Score:

| Condition | Score |
| --- | --- |
| pump.fun pre-graduation / DEX liquidity unavailable | 55 |
| liquidity `<= 0` and not recognized pre-graduation | 0 |
| `< $1k` | 10 |
| `$1k - $5k` | 30 |
| `$5k - $20k` | 55 |
| `$20k - $100k` | 80 |
| `>= $100k` | 95 |

Hard fails:

- `DEX liquidity unavailable / no usable pool` when liquidity is unavailable/zero and not recognized as pre-graduation.
- `liquidity too thin at $X` when liquidity is below $1k.

Warnings:

- `DEX liquidity unavailable / likely pre-graduation` for pump.fun bonding-curve tokens.
- `liquidity thin at $X` for liquidity below $5k but at least $1k.

This intentionally lets pre-graduation pump.fun signals be studied, but marks their fill model as lower confidence.

## Distribution score and top-holder gate

Input:

- top-10 holder percentage from Solana RPC where available, or pump.fun metadata fallback.

If holder concentration is unavailable:

- Score: 55.
- Warning: `top holder concentration unavailable`.

For pump.fun pre-graduation tokens:

| Top-10 holder % | Score / outcome |
| --- | --- |
| `> 95%` | score 0, hard fail |
| `> 90%` | score 10, warning |
| `> 70%` | score 25, warning |
| `> 60%` | score 35, warning |
| `> 45%` | score 55, warning |
| `> 30%` | score 78 |
| `<= 30%` | score 95 |

For normal DEX-pool tokens:

| Top-10 holder % | Score / outcome |
| --- | --- |
| `> 70%` | score 0, hard fail |
| `> 60%` | score 30, warning |
| `> 45%` | score 55, warning |
| `> 30%` | score 78 |
| `<= 30%` | score 95 |

Distribution has the largest composite weight at 30%.

## Velocity score

Inputs:

- 5m buys and sells
- 1h buys and sells

Calculated values:

```text
m5_buy_ratio = buys_5m / (buys_5m + sells_5m), or 0.5 if no activity
h1_buy_ratio = buys_1h / (buys_1h + sells_1h), or 0.5 if no activity
activity = min(1, (m5_total / 30) * 0.6 + (h1_total / 250) * 0.4)
ratio_score = clamp((m5_buy_ratio * 0.7 + h1_buy_ratio * 0.3) * 100, 0, 100)
velocity = round(ratio_score * 0.65 + activity * 100 * 0.35)
```

Hard fail:

- If 5m sells are greater than both `10` and `2.5 * buys_5m`, add `sell pressure dominates 5m flow`.

## Age score

Input:

- Pair/token age in minutes, when known.

| Age | Score |
| --- | --- |
| unknown | 50 |
| `< 3 min` | 25 |
| `3 - 15 min` | 60 |
| `15 min - 6h` | 90 |
| `6h - 24h` | 75 |
| `1d - 7d` | 55 |
| `> 7d` | 35 |

This favors tokens that are new enough to have alpha but not so new that all market data is meaningless.

## Signal retry behavior

If a convergence signal appears but market data is not ready:

- The signal is not immediately marked failed.
- It is queued in `SignalRetryQueue`.
- Retry delays are 30s, 90s, 180s, and 480s.
- If scoring eventually succeeds, the normal score/pass/fail path runs.
- If retries continue to fail, the queue eventually stops retrying that token until a new signal path reintroduces it.

This matters for fresh pump.fun or just-graduated tokens where indexers may lag wallet activity.

## Paper entry model

A passing signal calls `PaperTrader.openFromSignal()`.

Entry steps:

1. Use the score snapshot's observed `priceUsd`.
2. Estimate paper execution using configured position size and liquidity basis.
3. Store both observed price and estimated fill price.
4. Use `estimatedFillPriceUsd` as `entry_price_usd` if positive, otherwise observed price.
5. Store signal timing metadata.

Default paper sizing from `.env.example`:

```text
MAX_PAPER_POSITION_SOL=0.10
PAPER_SOL_USD_FOR_ESTIMATES=90
PAPER_COMPARISON_NOTIONAL_USD=100
```

Notional estimate:

```text
notional_usd = MAX_PAPER_POSITION_SOL * PAPER_SOL_USD_FOR_ESTIMATES
```

With the defaults, the paper entry notional estimate is $9.

## Fill/slippage model

`estimatePaperExecution()` stores:

- observed price USD
- estimated fill price USD
- estimated slippage bps
- estimated price impact bps
- paper notional USD
- comparison notional USD and comparison fill/slippage
- effective liquidity USD
- liquidity basis
- liquidity confidence
- fill model
- fill source
- timing fields from signal to fill

Liquidity basis rules:

| Market data | Effective liquidity | Confidence | Fill model |
| --- | --- | --- | --- |
| DEX liquidity > 0 | actual DEX liquidity | high | `dex_constant_product_v1` |
| pump.fun bonding curve / pump.fun source | 5% of first positive market cap, FDV, or native volume; clamped $250-$25k; fallback $500 | low | `pumpfun_curve_proxy_v1` |
| unavailable | null | unknown | `unavailable_v1` |

Slippage estimate:

```text
input_reserve_usd = effective_liquidity_usd / 2
slippage_bps = notional_usd / (input_reserve_usd + notional_usd) * 10000
estimated_fill_price = observed_price * (1 + slippage_bps / 10000)
```

This is an approximation for paper research. It is not a guarantee of executable price.

## Signal-to-fill timing metadata

The bot stores these latency fields on paper trades:

- `signal_first_seen_at`: first wallet buy timestamp.
- `signal_last_seen_at`: latest wallet buy timestamp.
- `signal_created_at`: paper entry creation timestamp.
- `first_wallet_to_fill_seconds`: fill time minus first wallet buy time.
- `latest_wallet_to_fill_seconds`: fill time minus latest wallet buy time.
- `signal_to_fill_seconds`: fill time minus signal creation time.

These fields help answer whether the bot would have been early enough after wallet convergence.

## Paper position updates

Open paper positions are refreshed:

- at the end of every scan; and
- on a separate timer in continuous mode; and
- when `status --refresh` or `report --refresh` is explicitly used.

For each open trade:

1. Fetch current market snapshot through the DexScreener/pump.fun client.
2. Skip update if no valid current price exists.
3. Calculate current multiplier and PnL percent from current price vs entry fill price.
4. Update last price, last multiplier, last PnL, last liquidity, and last checked time.
5. Update `max_multiplier` if current multiplier is a new peak.
6. Apply take-profit inventory reductions.
7. Check trailing stop.
8. Check fixed stop loss.

## Take-profit ladder

Defaults:

```text
TAKE_PROFIT_1_MULTIPLE=2
TAKE_PROFIT_2_MULTIPLE=3
TAKE_PROFIT_3_MULTIPLE=5
```

Inventory rule:

| Threshold reached | Remaining paper inventory |
| --- | --- |
| 2x | 80% |
| 3x | 50% |
| 5x | 20% |

Implementation detail:

- The bot stores one `remaining_percent` value.
- It does not store realized partial-exit lots.
- Final close PnL is still based on final close price vs entry price.
- Reports distinguish this as a paper approximation.

## Stop loss

Default:

```text
STOP_LOSS_PERCENT=-40
```

If current PnL percent is less than or equal to this value, the trade closes with reason:

```text
stop loss -40%
```

The config clamps this value to be zero or negative.

## Trailing stop

Defaults:

```text
PAPER_TRAILING_STOP_ACTIVATION_MULTIPLE=1.5
PAPER_TRAILING_STOP_DRAWDOWN_PERCENT=30
```

Rule:

1. Track the highest observed multiplier.
2. Do nothing until peak multiplier is at least the activation multiple.
3. Calculate drawdown from peak:

```text
drawdown_percent = (1 - current_multiplier / max_multiplier) * 100
```

4. If drawdown is at least the configured drawdown percent, close remaining paper trade.

Reason format includes the configured drawdown, peak multiple, current multiple, and observed drawdown.

Set drawdown to 0 to disable trailing stops.

## Tracked-wallet sell emergency exit

Sell events do not create buy signals. They feed a paper exit heuristic.

When a watched wallet sells a token:

1. The sale is stored in an in-memory tracked-sell map keyed by token.
2. The active window is `max(600, SIGNAL_WINDOW_SECONDS)` seconds.
3. If two unique tracked wallets sell the same token inside that window, an open paper trade for that token can be closed.
4. The close reason is:

```text
2+ tracked wallets sold inside exit window
```

This is a paper-only risk-management heuristic.

## Alerts

Passing signal alerts:

- Sent to Telegram if `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are configured.
- Otherwise printed in logs as `[ALERT]`.

Exit alerts:

- Sent/logged when `PaperTrader` closes a trade through emergency exit, trailing stop, or stop loss.

Alerts should be interpreted as evidence to review, not as live trade instructions.

## Reports and status

`npm run status` prints:

- dry-run mode
- active wallet count
- wallet tier counts
- API budget status
- signal count
- pending market retry count
- open and closed paper trade counts
- average final-exit PnL and final-exit win rate
- paper portfolio summary
- open positions
- closed positions
- wallet performance summary

`npm run report` includes the same status text plus recent signals and reasons/warnings.

Use `--refresh` on status/report when you want to refresh open paper positions first:

```bash
npm run status -- --refresh
npm run report -- --refresh
```

## Wallet performance attribution

Each signal stores `wallets_json`. Wallet performance reconstructs attribution from those rows and linked paper trades.

Per wallet, it computes:

- total signals
- passed signals
- pass rate
- paper trades
- open/closed trade counts
- open exposure SOL
- win rate from closed trades
- average and median final close PnL
- average slippage bps
- average latest-wallet-to-fill latency
- average signal-to-fill latency
- bad signal streak
- alpha score
- recommendation
- suggested trust
- sample symbols

## Wallet alpha score

Starting score:

```text
45
```

Adjustments:

- `+ min(12, signals * 0.8)`
- `+ min(10, closed_trades * 2)`
- `+ min(12, pass_rate_percent * 0.12)`
- `+ (win_rate_percent - 50) * 0.35`, when win rate exists
- `+ avg_pnl_percent * 0.8`, when average PnL exists
- `- min(10, (avg_slippage_bps - 100) / 50)`, when average slippage is above 100 bps
- `- bad_signal_streak * 4`

The result is clamped 0-100 and rounded.

## Wallet recommendations

Recommendation rules:

| Condition | Recommendation | Reason |
| --- | --- | --- |
| fewer than 2 closed trades | `keep` | thin closed-trade sample; keep observing |
| at least 8 closed trades, avg PnL `< 0`, win rate `< 25%`, and bad streak `>= 4` or adverse exits `>= 4` | `disable_candidate` | persistent negative expectancy with weak win rate and repeated losses/adverse exits |
| at least 2 closed trades and repeated stop/emergency exits `>= 2` | `demote` | repeated adverse exits; lower tier until signals improve |
| at least 2 closed trades and avg PnL `< 0` | `demote` | closed losses and negative expectancy across paper trades |
| at least 2 closed trades and win rate `< 25%` | `demote` | paper win rate below 25%; demote despite any outlier gains |
| bad streak `>= 2` | `probation` | recent losing streak; require better next signals |
| fewer than 5 closed trades after the demote/probation checks | `keep` | positive but thin sample; need 5 closed trades before promotion |
| at least 5 closed trades with avg PnL `< +8%` or win rate `< 30%` | `probation` | positive sample is not yet strong enough for promotion |
| at least 5 closed trades, avg PnL `>= +8%`, win rate `>= 30%`, bad streak `<= 2` | `promote` | positive expectancy with controlled bad streak |
| promotion case with avg PnL `>= +15%`, win rate `>= 35%`, and median PnL near positive | `promote` | strong positive expectancy |
| otherwise | `keep` | sample usable; keep current tier |

Suggested trust is still computed and displayed as a tracked parameter, but wallet rotation does not currently write suggested trust back into `watched-wallets.json` or use trust in tier-ranking math. Trust/weighted-trust should stay observational until it is tuned further.

Wallet rotation uses recommendations plus tier limits to assign hot/probation/candidate/archive tiers.

## Interpretation guidance

Good signal evidence:

- Multiple high-quality wallets converge before broad volume is obvious.
- Market data exists quickly enough for a realistic fill.
- Holder concentration is not extreme.
- Liquidity/fill model is plausible for the paper notional.
- Paper trade outcome validates the wallets repeatedly, not just once.

Bad signal evidence:

- Signals arrive after the obvious candle.
- Market data is unavailable too long.
- Holder concentration is extreme.
- Liquidity is too thin for even a tiny notional.
- Tracked wallets sell immediately after convergence.
- The same wallets repeatedly produce stop-loss/trailing drawdown exits.

The system is designed to make those distinctions auditable, not to blindly copy wallets.
