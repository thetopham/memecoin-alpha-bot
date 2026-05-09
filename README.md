# Memecoin Alpha Bot

Dry-run Solana memecoin alpha scanner inspired by `thegreatola/memecoins-trading-agent`.

V1 is intentionally read-only/paper-trading:

- watches configured Solana wallets with Helius RPC polling
- parses buy/sell swaps involving Pump.fun, Raydium, Jupiter, Orca
- detects convergence when 2+ watched wallets buy the same mint inside a short window
- enriches tokens from DexScreener
- checks top-holder concentration through Solana RPC `getTokenLargestAccounts`
- scores token risk/alpha
- logs events/signals/paper trades into SQLite
- sends optional Telegram alerts only on meaningful clean signals/exits
- paper exits use a hard stop, staged take-profits, and a configurable trailing stop from observed peak

It does not store or need a wallet private key. It does not execute Jupiter swaps.

## Commands

```bash
npm install
npm test
npm run build
npm run wallets
npm run scan:once
npm run status
npm run report
npm run dev      # continuous scanner
```

## Config

1. Copy `.env.example` to `.env` and fill Helius values.
2. Edit `config/watched-wallets.json` with 2+ wallets to watch.
3. Keep `DRY_RUN=true`.

A single watched wallet can collect events but cannot trigger a convergence signal.

Exit defaults: `STOP_LOSS_PERCENT=-40`, take-profits at `2x/3x/5x`, and `PAPER_TRAILING_STOP_DRAWDOWN_PERCENT=30` after `PAPER_TRAILING_STOP_ACTIVATION_MULTIPLE=1.5`. Set trailing drawdown to `0` to disable.

Dashboard auth: binding the dashboard to a LAN/non-loopback host requires `DASHBOARD_AUTH_TOKEN` unless you explicitly set `DASHBOARD_INSECURE=true`. Send the token in the `x-dashboard-token` header; URL query-string tokens are rejected so tokens do not leak through URLs/logs.

## Safety boundary

This project is for alpha research and paper trading. It refuses live execution in v1. To add live execution later, use a burner wallet, a tiny capped bankroll, explicit approval, and separate review.
