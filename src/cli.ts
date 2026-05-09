import { loadConfig } from './config';
import { addWallet, loadWallets } from './wallets';
import { Orchestrator } from './orchestrator';
import { runCieloWalletDiscoveryCli } from './cieloWalletDiscovery';
import { startDashboardServer } from './dashboard';

async function main(): Promise<void> {
  const [cmd = 'status', ...args] = process.argv.slice(2);
  const cfg = loadConfig();

  if (cmd === 'wallets') {
    const wallets = loadWallets(cfg.watchedWalletsPath);
    if (wallets.length === 0) console.log('No watched wallets configured.');
    else wallets.forEach((w, idx) => console.log(`${idx + 1}. ${w.address} label=${w.label ?? ''} trust=${w.trust ?? 1} tier=${w.tier ?? 'hot'}`));
    return;
  }

  if (cmd === 'add-wallet') {
    const [address, label, trustRaw] = args;
    if (!address) throw new Error('Usage: npm run add-wallet -- <address> [label] [trust]');
    const trust = trustRaw ? Number(trustRaw) : 1;
    const wallets = addWallet(cfg.watchedWalletsPath, address, label, Number.isFinite(trust) ? trust : 1);
    console.log(`Configured ${wallets.length} enabled wallet(s).`);
    return;
  }

  if (cmd === 'discover-wallets' || cmd === 'discover-cielo-wallets') {
    await runCieloWalletDiscoveryCli(args, cfg);
    return;
  }

  if (cmd === 'dashboard') {
    const { host, port, refreshSeconds } = parseDashboardArgs(args);
    const server = await startDashboardServer(cfg, { host, port, refreshSeconds });
    const shutdown = () => server.close(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await new Promise(() => undefined);
    return;
  }

  const orchestrator = new Orchestrator(cfg);
  try {
    if (cmd === 'run') {
      await orchestrator.run();
      process.on('SIGINT', () => { orchestrator.stop(); process.exit(0); });
      process.on('SIGTERM', () => { orchestrator.stop(); process.exit(0); });
      await new Promise(() => undefined);
      return;
    }

    if (cmd === 'scan-once') {
      const includeHistory = args.includes('--include-history');
      const result = await orchestrator.scanOnce(includeHistory);
      console.log(`scan complete: ${result.events} events (${result.buys} buys, ${result.sells} sells)`);
      return;
    }

    if (cmd === 'status') {
      if (args.includes('--refresh')) await orchestrator.refreshOpenPositions();
      console.log(orchestrator.statusText());
      return;
    }

    if (cmd === 'report') {
      if (args.includes('--refresh')) await orchestrator.refreshOpenPositions();
      console.log(orchestrator.reportText());
      return;
    }

    if (cmd === 'wallet-performance' || cmd === 'wallet-scoreboard') {
      const limit = Number(args[0] ?? 12);
      console.log(orchestrator.walletPerformanceText(Number.isFinite(limit) ? limit : 12));
      return;
    }

    if (cmd === 'wallet-maintenance' || cmd === 'rotate-wallets') {
      const result = await orchestrator.maintainWallets(true);
      console.log(`wallet maintenance complete: ${result.wallets} active wallet(s), ${result.changes.length} change(s)`);
      for (const change of result.changes.slice(0, 25)) console.log(`- ${change}`);
      if (result.changes.length > 25) console.log(`- … ${result.changes.length - 25} more`);
      return;
    }

    throw new Error(`Unknown command: ${cmd}`);
  } finally {
    if (cmd !== 'run') orchestrator.stop();
  }
}

function parseDashboardArgs(args: string[]): { host?: string; port?: number; refreshSeconds?: number } {
  let host: string | undefined;
  let port: number | undefined;
  let refreshSeconds: number | undefined;
  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx];
    const next = args[idx + 1];
    if (arg === '--host' && next) {
      host = next;
      idx += 1;
    } else if (arg.startsWith('--host=')) {
      host = arg.slice('--host='.length);
    } else if (arg === '--port' && next) {
      port = Number(next);
      idx += 1;
    } else if (arg.startsWith('--port=')) {
      port = Number(arg.slice('--port='.length));
    } else if ((arg === '--refresh' || arg === '--refresh-seconds') && next) {
      refreshSeconds = Number(next);
      idx += 1;
    } else if (arg.startsWith('--refresh=')) {
      refreshSeconds = Number(arg.slice('--refresh='.length));
    } else if (arg.startsWith('--refresh-seconds=')) {
      refreshSeconds = Number(arg.slice('--refresh-seconds='.length));
    }
  }
  return {
    host,
    port: Number.isFinite(port) ? port : undefined,
    refreshSeconds: Number.isFinite(refreshSeconds) ? refreshSeconds : undefined,
  };
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
