import type { WalletConfig, WalletSwapEvent, WalletTier } from './types';
import type { AlphaDb } from './db';
import { SolanaRpcClient } from './rpc';
import { parseWalletSwap } from './transactionParser';
import { nowSeconds, shortAddress } from './utils';

interface SignatureInfo {
  signature: string;
  blockTime?: number | null;
  err?: unknown;
}

export interface WalletScanBudget {
  allowTier(tier: WalletTier, estimatedCredits: number, now: number): { allowed: boolean; reason: string };
}

export interface PollingWalletTrackerOptions {
  maxSignaturePages?: number;
  scanIntervalsSeconds?: Partial<Record<WalletTier, number>>;
  budget?: WalletScanBudget;
  now?: () => number;
}

const DEFAULT_MAX_SIGNATURE_PAGES = 6;

export class PollingWalletTracker {
  private readonly maxSignaturePages: number;
  private readonly scanIntervalsSeconds: Partial<Record<WalletTier, number>>;
  private readonly budget?: WalletScanBudget;
  private readonly now: () => number;

  constructor(
    private readonly rpc: SolanaRpcClient,
    private readonly db: AlphaDb,
    private readonly signatureLimit: number,
    options: PollingWalletTrackerOptions = {},
  ) {
    this.maxSignaturePages = Math.max(1, options.maxSignaturePages ?? DEFAULT_MAX_SIGNATURE_PAGES);
    this.scanIntervalsSeconds = options.scanIntervalsSeconds ?? {};
    this.budget = options.budget;
    this.now = options.now ?? nowSeconds;
  }

  private async fetchSignatures(wallet: WalletConfig, lastSignature: string | null, includeHistory: boolean): Promise<SignatureInfo[]> {
    const pages = lastSignature || includeHistory ? this.maxSignaturePages : 1;
    const signatures: SignatureInfo[] = [];
    let before: string | undefined;

    for (let page = 0; page < pages; page += 1) {
      const pageSignatures = await this.rpc.getSignaturesForAddress(wallet.address, this.signatureLimit, before);
      if (pageSignatures.length === 0) break;
      signatures.push(...pageSignatures);
      if (lastSignature && pageSignatures.some(sig => sig.signature === lastSignature)) break;
      if (pageSignatures.length < this.signatureLimit) break;
      before = pageSignatures[pageSignatures.length - 1]?.signature;
      if (!before) break;
    }

    if (lastSignature && signatures.length > 0 && !signatures.some(sig => sig.signature === lastSignature)) {
      console.warn(`[WalletTracker] checkpoint ${lastSignature.slice(0, 8)} not found for ${shortAddress(wallet.address)} after ${this.maxSignaturePages} page(s); processing bounded catch-up window`);
    }
    return signatures;
  }

  private walletTier(wallet: WalletConfig): WalletTier {
    return wallet.tier === 'probation' || wallet.tier === 'candidate' || wallet.tier === 'archive' ? wallet.tier : 'hot';
  }

  private estimatedWalletScanCredits(includeHistory: boolean, hasCheckpoint: boolean): number {
    const pages = hasCheckpoint || includeHistory ? this.maxSignaturePages : 1;
    return pages + pages * this.signatureLimit;
  }

  private shouldScanWallet(wallet: WalletConfig, includeHistory: boolean): { scan: boolean; reason?: string; now: number } {
    const now = this.now();
    const tier = this.walletTier(wallet);
    if (wallet.enabled === false || tier === 'archive') return { scan: false, reason: 'disabled/archive', now };
    const lastSignature = this.db.getState(`last_signature:${wallet.address}`);
    const budget = this.budget?.allowTier(tier, this.estimatedWalletScanCredits(includeHistory, Boolean(lastSignature)), now);
    if (budget && !budget.allowed) return { scan: false, reason: budget.reason, now };
    if (!includeHistory) {
      const interval = Math.max(0, this.scanIntervalsSeconds[tier] ?? 0);
      if (interval > 0) {
        const last = Number(this.db.getState(`last_wallet_scan:${wallet.address}`) ?? 0);
        if (Number.isFinite(last) && last > 0 && now - last < interval) {
          return { scan: false, reason: `${tier} interval ${interval}s not elapsed`, now };
        }
      }
    }
    return { scan: true, now };
  }

  private markWalletScanSuccess(wallet: WalletConfig, now: number): void {
    this.db.setState(`last_wallet_scan:${wallet.address}`, String(now), now);
  }

  async pollWallet(wallet: WalletConfig, includeHistory = false): Promise<WalletSwapEvent[]> {
    const scanDecision = this.shouldScanWallet(wallet, includeHistory);
    if (!scanDecision.scan) return [];
    const stateKey = `last_signature:${wallet.address}`;
    const lastSignature = this.db.getState(stateKey);
    const signatures = await this.fetchSignatures(wallet, lastSignature, includeHistory);
    if (signatures.length === 0) {
      this.markWalletScanSuccess(wallet, scanDecision.now);
      return [];
    }

    const newest = signatures[0]?.signature;
    if (!lastSignature && !includeHistory) {
      this.db.setState(stateKey, newest, nowSeconds());
      this.markWalletScanSuccess(wallet, scanDecision.now);
      return [];
    }

    const fresh: SignatureInfo[] = [];
    for (const sig of signatures) {
      if (sig.signature === lastSignature) break;
      if (!sig.err) fresh.push(sig);
    }
    fresh.reverse();

    const events: WalletSwapEvent[] = [];
    let checkpoint: string | null = lastSignature;
    let interrupted = false;
    for (const sig of fresh) {
      try {
        const tx = await this.rpc.getParsedTransaction(sig.signature);
        if (!tx) {
          interrupted = true;
          console.warn(`[WalletTracker] transaction ${sig.signature.slice(0, 8)} unavailable for ${shortAddress(wallet.address)}; leaving checkpoint unchanged for retry`);
          break;
        }
        const event = parseWalletSwap({ ...tx, signature: sig.signature, blockTime: sig.blockTime }, wallet.address, sig.blockTime ?? nowSeconds());
        if (event) events.push(event);
        checkpoint = sig.signature;
      } catch (err) {
        interrupted = true;
        console.warn(`[WalletTracker] failed to parse ${sig.signature.slice(0, 8)} for ${shortAddress(wallet.address)}: ${(err as Error).message}`);
        break;
      }
    }

    if (checkpoint && checkpoint !== lastSignature) {
      this.db.setState(stateKey, checkpoint, nowSeconds());
    } else if (!interrupted && newest && fresh.length === 0 && newest !== lastSignature) {
      this.db.setState(stateKey, newest, nowSeconds());
    }
    if (!interrupted) this.markWalletScanSuccess(wallet, scanDecision.now);
    return events;
  }

  async pollAll(wallets: WalletConfig[], includeHistory = false): Promise<WalletSwapEvent[]> {
    const all: WalletSwapEvent[] = [];
    for (const wallet of wallets) {
      try {
        const events = await this.pollWallet(wallet, includeHistory);
        all.push(...events);
      } catch (err) {
        console.warn(`[WalletTracker] poll failed for ${shortAddress(wallet.address)}: ${(err as Error).message}`);
      }
    }
    return all.sort((a, b) => a.timestamp - b.timestamp);
  }
}
