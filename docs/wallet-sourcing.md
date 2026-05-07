# Wallet sourcing playbook

The bot needs external wallets to watch. Your own wallet is not alpha; it is now kept in the config as disabled metadata so it does not contaminate signals.

## Current starter source

I seeded the watchlist from a public Dune dashboard:

- Dashboard: `Pump.Fun Alpha Wallets` by `adam_tehc`
- Source type: Pump.fun / PumpSwap realized-profit leaderboard
- Why useful: quick public seed list of active Pump.fun wallets
- Why risky: top-profit wallets can be bots, market makers, deployer wallets, one-off jackpot wallets, or non-copyable whales

So these are not automatically "good" wallets. They are seed wallets for dry-run measurement.

## Cielo workflow

Cielo is probably what the README was referring to.

Use:

- `https://app.cielo.finance/wallet-discovery`
- Docs: `https://docs.cielo.finance/guides/copy-trading/finding-good-wallets`

Cielo's own guidance says to find wallets by sorting/filtering Wallet Discovery by:

1. chain = Solana
2. realized PnL
3. ROI
4. win rate
5. last trade within 24 hours
6. tags such as:
   - Human Operated
   - Gem Finder
   - High Winrate
7. then manually inspect full trading history:
   - does it cut losses quickly?
   - is profit consistent or one lucky hit?
   - is it obviously a bot/contract/deployer?
   - does it buy before crowd momentum, or only after candles are already obvious?

Cielo Wallet Discovery appears to require a Pro/Whale plan for the leaderboard. The free plan still supports wallet profiles and tracking limits, but not necessarily the full discovery dashboard.

## Other wallet sources

Good public seed sources:

- Dune Pump.fun alpha-wallet dashboards
- Nansen Solana Smart Money / wallet explorer
- Solscan token-holder pages for recent winners
- DexScreener trending tokens, then inspect earliest buyers / profitable sellers
- Cielo public lists / wallet profiles
- Telegram/Discord call groups only as candidate sources, never as truth

## Qualification rules before trusting a wallet

Start low trust, e.g. `0.4` to `0.7`, unless the wallet passes multiple checks.

Promote trust only if paper data shows:

- repeated early entries before broad momentum
- exits before rugs/dumps
- profit across multiple tokens, not one lucky trade
- not just sniping every launch indiscriminately
- no obvious deployer/rug/insider pattern
- not an exchange, router, aggregator, LP wallet, or MEV/bot spammer

Demote/remove if:

- creates too many false positives
- buys after pumps, not before
- is mostly wash/bot activity
- repeatedly leads to paper drawdowns
- only performs in old historical data

## Practical trust tiers

- `0.3` = noisy public lead
- `0.5` = plausible but unverified
- `0.6` = starter public leaderboard wallet
- `0.8` = manually reviewed and active
- `1.0` = paper-tracked performer with repeatable edge

## Candidate vetting workflow

Candidate wallets live in:

```text
config/wallet-candidates.json
```

Run a read-only wallet screen before adding candidates to the live watchlist:

```bash
cd /home/thetopham/memecoin-alpha-bot
PATH=/home/thetopham/.local/bin:$PATH npm run vet-wallets -- --signatures=40
```

The evaluator samples recent signatures through Solana RPC, parses Pump.fun/Raydium/Jupiter/Orca swaps, and classifies each candidate as:

- `keep`: active enough to add with starter trust 0.50-0.55
- `probation`: data is usable but too thin/noisy for automatic alpha inclusion
- `reject`: inactive, sell-only, no parseable swaps, too small/noisy, or too narrow

Apply only `keep` wallets to `config/watched-wallets.json`:

```bash
PATH=/home/thetopham/.local/bin:$PATH npm run vet-wallets -- --apply --signatures=40
```

Do not use `--include-probation` unless you intentionally want more noise. Low-trust wallets still count toward the current 2-wallet convergence threshold, so probation wallets can create false positives.

Reports are written to:

```text
data/wallet-vetting-report.json
```

## Add a wallet manually

```bash
cd /home/thetopham/memecoin-alpha-bot
npm run add-wallet -- <WALLET_ADDRESS> <label> 0.6
```

## Review active wallets

```bash
cd /home/thetopham/memecoin-alpha-bot
npm run wallets
```

## Run one dry scan

```bash
cd /home/thetopham/memecoin-alpha-bot
npm run scan:once
npm run report
```

## Important

Do not put your own wallet in the active alpha set unless you intentionally want to monitor yourself. It should not be used as a copy-trading signal.
