import { loadConfig } from './config';
import { addWallet, loadWallets } from './wallets';
import { Orchestrator } from './orchestrator';

async function main(): Promise<void> {
  const [cmd = 'status', ...args] = process.argv.slice(2);
  const cfg = loadConfig();

  if (cmd === 'wallets') {
    const wallets = loadWallets(cfg.watchedWalletsPath);
    if (wallets.length === 0) console.log('No watched wallets configured.');
    else wallets.forEach((w, idx) => console.log(`${idx + 1}. ${w.address} label=${w.label ?? ''} trust=${w.trust ?? 1}`));
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
      console.log(orchestrator.statusText());
      return;
    }

    if (cmd === 'report') {
      console.log(orchestrator.reportText());
      return;
    }

    throw new Error(`Unknown command: ${cmd}`);
  } finally {
    if (cmd !== 'run') orchestrator.stop();
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
