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

## Safety boundary

This project is for alpha research and paper trading. It refuses live execution in v1. To add live execution later, use a burner wallet, a tiny capped bankroll, explicit approval, and separate review.
