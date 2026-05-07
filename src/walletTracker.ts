import type { WalletConfig, WalletSwapEvent } from './types';
import type { AlphaDb } from './db';
import { SolanaRpcClient } from './rpc';
import { parseWalletSwap } from './transactionParser';
import { nowSeconds, shortAddress } from './utils';

export class PollingWalletTracker {
  constructor(
    private readonly rpc: SolanaRpcClient,
    private readonly db: AlphaDb,
    private readonly signatureLimit: number,
  ) {}

  async pollWallet(wallet: WalletConfig, includeHistory = false): Promise<WalletSwapEvent[]> {
    const stateKey = `last_signature:${wallet.address}`;
    const lastSignature = this.db.getState(stateKey);
    const signatures = await this.rpc.getSignaturesForAddress(wallet.address, this.signatureLimit);
    if (signatures.length === 0) return [];

    const newest = signatures[0]?.signature;
    if (!lastSignature && !includeHistory) {
      this.db.setState(stateKey, newest, nowSeconds());
      return [];
    }

    const fresh: typeof signatures = [];
    for (const sig of signatures) {
      if (sig.signature === lastSignature) break;
      if (!sig.err) fresh.push(sig);
    }
    fresh.reverse();

    const events: WalletSwapEvent[] = [];
    for (const sig of fresh) {
      try {
        const tx = await this.rpc.getParsedTransaction(sig.signature);
        if (!tx) continue;
        const event = parseWalletSwap({ ...tx, signature: sig.signature, blockTime: sig.blockTime ?? tx.blockTime }, wallet.address, sig.blockTime ?? nowSeconds());
        if (event) events.push(event);
      } catch (err) {
        console.warn(`[WalletTracker] failed to parse ${sig.signature.slice(0, 8)} for ${shortAddress(wallet.address)}: ${(err as Error).message}`);
      }
    }

    if (newest) this.db.setState(stateKey, newest, nowSeconds());
    return events;
  }

  async pollAll(wallets: WalletConfig[], includeHistory = false): Promise<WalletSwapEvent[]> {
    const all: WalletSwapEvent[] = [];
    for (const wallet of wallets) {
      const events = await this.pollWallet(wallet, includeHistory);
      all.push(...events);
    }
    return all.sort((a, b) => a.timestamp - b.timestamp);
  }
}
