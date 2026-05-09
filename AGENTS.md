# AGENTS.md — Memecoin Alpha Bot

Project: /home/thetopham/memecoin-alpha-bot

This repo is a dry-run Solana memecoin alpha scanner inspired by thegreatola/memecoins-trading-agent. The upstream repo was incomplete; this local project contains the runnable implementation.

## Safety boundary

- Keep DRY_RUN=true unless the user explicitly approves a new live-trading scope.
- Do not request, store, print, or use wallet private keys.
- Do not add live swaps/Jupiter execution without explicit approval, extra tests, burner-wallet design, and loss caps.
- Do not build wash trading, fake volume, pump coordination, deceptive launch/rug tooling, or manipulative bots.
- Treat outputs as experimental market intelligence, not financial advice.

## Current automation

- Systemd user service: memecoin-alpha-bot.service
- Service file: ~/.config/systemd/user/memecoin-alpha-bot.service
- Runs: npm run start
- Project env: .env, mode 0600, contains API keys; never print it.
- DB: data/memecoin-alpha.sqlite
- Watchlist: config/watched-wallets.json
- Discord report cron: Hermes job 091933030c95, every 30m, target #crypto (Discord channel id 1501825597691662377)
- Report script: ~/.hermes/scripts/memecoin_alpha_report.sh
- Read-only paper dashboard service: memecoin-alpha-dashboard.service
- Dashboard URL on LAN: http://192.168.0.32:8788/
- LAN/non-loopback dashboard binds require DASHBOARD_AUTH_TOKEN unless DASHBOARD_INSECURE=true is explicitly accepted; auth uses the x-dashboard-token header, not URL query params.
- Dashboard UI is mobile-friendly card/KPI layout: hero metrics, portfolio cards, open/closed trade cards, wallet scorecards, signal cards, with raw report text tucked into expandable details.

## Commands

```bash
cd /home/thetopham/memecoin-alpha-bot
npm run wallets
npm run status
npm run report
npm run wallet-performance -- 12
npm run dashboard -- --host 0.0.0.0 --port 8788
npm run scan:once
npm test
npm run build
```

Service commands:

```bash
systemctl --user status memecoin-alpha-bot.service --no-pager
systemctl --user status memecoin-alpha-dashboard.service --no-pager
journalctl --user -u memecoin-alpha-bot.service -f
journalctl --user -u memecoin-alpha-dashboard.service -f
systemctl --user restart memecoin-alpha-bot.service
systemctl --user restart memecoin-alpha-dashboard.service
```

Add wallet:

```bash
npm run add-wallet -- <WALLET_ADDRESS> <label> 0.6
```

## Signal logic

- Convergence threshold: 2+ enabled watched wallets within 300s.
- Poll interval: 10s for better early pump.fun latency while still dry-run.
- Min composite score: 60.
- Paper entries use an execution-realism estimate: observed price → estimated fill price, modeled slippage, wallet-action-to-fill latency, and a configured $100 size-check comparison.
- Wallet Alpha Scoreboard attributes each signal/trade result to participating wallets and reports signals, pass rate, paper trade counts, win rate, avg/median PnL, slippage, latency, open exposure, bad-signal streak, and suggested trust action. It is attribution, not proof of causality.
- Current paper sizing assumptions: MAX_PAPER_POSITION_SOL=0.10, PAPER_SOL_USD_FOR_ESTIMATES=90, PAPER_COMPARISON_NOTIONAL_USD=100.
- Paper exits: hard stop STOP_LOSS_PERCENT=-40, take-profit ladder 2x→80% / 3x→50% / 5x→20%, and trailing stop on remaining inventory after PAPER_TRAILING_STOP_ACTIVATION_MULTIPLE=1.5 with PAPER_TRAILING_STOP_DRAWDOWN_PERCENT=30 from observed peak.
- A signal below score/liquidity threshold is logged as skipped.
- A passing signal opens a paper trade only.

## Voice

Use TRENCH_AGENT style: short, skeptical, data-first. No hype. No "LFG". Always include score, reason, wallet count, and dry-run boundary.
