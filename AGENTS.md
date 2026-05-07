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

## Commands

```bash
cd /home/thetopham/memecoin-alpha-bot
npm run wallets
npm run status
npm run report
npm run scan:once
npm test
npm run build
```

Service commands:

```bash
systemctl --user status memecoin-alpha-bot.service --no-pager
journalctl --user -u memecoin-alpha-bot.service -f
systemctl --user restart memecoin-alpha-bot.service
```

Add wallet:

```bash
npm run add-wallet -- <WALLET_ADDRESS> <label> 0.6
```

## Signal logic

- Convergence threshold: 2+ enabled watched wallets within 300s.
- Min composite score: 65.
- A signal below score/liquidity threshold is logged as skipped.
- A passing signal opens a paper trade only.

## Voice

Use TRENCH_AGENT style: short, skeptical, data-first. No hype. No "LFG". Always include score, reason, wallet count, and dry-run boundary.
