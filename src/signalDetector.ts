import type { ConvergenceSignal, ConvergenceWallet, WalletConfig, WalletSwapEvent } from './types';
import { uniq } from './utils';

export interface SignalDetectorOptions {
  minWallets: number;
  windowSeconds: number;
  wallets?: WalletConfig[];
}

export class SignalDetector {
  private readonly eventsByToken = new Map<string, WalletSwapEvent[]>();
  private readonly emittedAtByToken = new Map<string, number>();
  private readonly walletMeta = new Map<string, WalletConfig>();

  constructor(private readonly options: SignalDetectorOptions) {
    for (const wallet of options.wallets ?? []) this.walletMeta.set(wallet.address, wallet);
  }

  updateWallets(wallets: WalletConfig[]): void {
    this.walletMeta.clear();
    for (const wallet of wallets) this.walletMeta.set(wallet.address, wallet);
  }

  onBuyEvent(event: WalletSwapEvent): ConvergenceSignal | null {
    if (event.direction !== 'buy') return null;
    const token = event.tokenAddress;
    const cutoff = event.timestamp - this.options.windowSeconds;
    const active = (this.eventsByToken.get(token) ?? [])
      .filter(e => e.timestamp >= cutoff && e.timestamp <= event.timestamp);
    active.push(event);
    this.eventsByToken.set(token, active);

    const emittedAt = this.emittedAtByToken.get(token);
    if (emittedAt != null && event.timestamp - emittedAt <= this.options.windowSeconds) return null;
    if (emittedAt != null && event.timestamp - emittedAt > this.options.windowSeconds) this.emittedAtByToken.delete(token);

    const latestByWallet = new Map<string, WalletSwapEvent>();
    for (const buy of active) {
      const previous = latestByWallet.get(buy.wallet);
      if (!previous || buy.timestamp > previous.timestamp) latestByWallet.set(buy.wallet, buy);
    }

    if (latestByWallet.size < this.options.minWallets) return null;

    const wallets: ConvergenceWallet[] = [...latestByWallet.values()]
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(e => {
        const meta = this.walletMeta.get(e.wallet);
        return {
          wallet: e.wallet,
          label: meta?.label,
          trust: meta?.trust ?? 1,
          solAmount: e.solAmount,
          txHash: e.txHash,
          timestamp: e.timestamp,
          source: e.source,
        };
      });

    const weightedTrust = wallets.reduce((sum, wallet) => sum + wallet.trust, 0);
    const firstSeen = Math.min(...wallets.map(w => w.timestamp));
    const lastSeen = Math.max(...wallets.map(w => w.timestamp));
    const signal: ConvergenceSignal = {
      tokenAddress: token,
      wallets,
      walletCount: wallets.length,
      weightedTrust,
      windowSeconds: lastSeen - firstSeen,
      firstSeen,
      lastSeen,
      sources: uniq(wallets.map(w => w.source)),
    };

    this.emittedAtByToken.set(token, event.timestamp);
    return signal;
  }
}
