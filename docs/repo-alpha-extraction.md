# Alpha extracted from upstream repo

Source inspected: `thegreatola/memecoins-trading-agent` commit `4a65560`.

The upstream repo is a useful blueprint but not a complete runnable app. It currently contains docs plus two TypeScript files, while the README references many missing files.

Concepts preserved in this build:

- smart-wallet convergence: 2-5 watched wallets buying the same mint within minutes
- score dimensions: volume, holders/distribution, dev/top-holder behavior, CT/momentum placeholder
- hard skip when top-holder concentration is too high
- staged exits at 2x/3x/5x, configurable peak-drawdown trailing stop, and emergency exits on tracked-wallet selling
- short Telegram alerts only for real signals/exits
- trade history as feedback loop, but only after sufficient dry-run data

Changes for safety and reliability:

- v1 is dry-run/paper-only; no private key support and no Jupiter execution
- Helius polling first, because it works over normal RPC and is easier to debug than transactionSubscribe
- SQLite ledger uses Node 22 built-in `node:sqlite` to avoid native npm modules on Raspberry Pi
- DexScreener enrichment is read-only
- holder concentration uses `getTokenLargestAccounts`/`getTokenSupply`
