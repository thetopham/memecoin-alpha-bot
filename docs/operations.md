# Operations

## Local dry run

```bash
cd /home/thetopham/memecoin-alpha-bot
npm run wallets
npm run scan:once
npm run status
npm run report
npm run dev
```

## Add wallets

A convergence signal needs 2+ enabled watched wallets.

```bash
npm run add-wallet -- <WALLET_ADDRESS> <label> 1.0
```

## First-run behavior

`PROCESS_HISTORICAL_ON_FIRST_RUN=false` means the first scan marks latest signatures as seen and does not backtest old wallet transactions. This avoids stale Telegram alerts.

For a one-time historical smoke test:

```bash
npm run scan:once -- --include-history
```

## Install as user systemd service

Do this only after tests/build pass and the watched wallet list is real:

```bash
cd /home/thetopham/memecoin-alpha-bot
bash scripts/install-user-service.sh
systemctl --user start memecoin-alpha-bot.service
systemctl --user status memecoin-alpha-bot.service --no-pager
journalctl --user -u memecoin-alpha-bot.service -f
```

## Safety

No private key is configured or supported in v1. Keep `DRY_RUN=true`.

The local `.env` contains an API key. Lock it down before running long-term:

```bash
chmod 600 /home/thetopham/memecoin-alpha-bot/.env
```
