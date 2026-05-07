# Hermes integration

This bot is a separate dry-run scanner service. Hermes can operate it from the Pi by running its CLI commands.

Useful Hermes prompts:

```text
Check the memecoin alpha bot status. Run `npm run status` in `/home/thetopham/memecoin-alpha-bot` and summarize.
```

```text
Show the latest memecoin alpha report. Run `npm run report` in `/home/thetopham/memecoin-alpha-bot` and summarize the signals.
```

```text
Add this Solana wallet to the memecoin alpha bot watchlist with trust 1.0: <wallet>
```

Recommended boundary:

- Hermes may read status/report and add watched wallets when you ask.
- Hermes should not add live trading or wallet private-key support without explicit approval.
- V1 should remain `DRY_RUN=true` until at least 1-2 weeks of paper signals are reviewed.

If you want this as an actual Hermes skill, create a local skill that loads this file and points to the project path.
