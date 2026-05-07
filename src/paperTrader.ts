import type { AppConfig, PaperTrade, TokenScore } from './types';
import type { AlphaDb } from './db';
import { DexScreenerClient } from './dexScreener';
import { nowSeconds } from './utils';
import { Notifier } from './notifier';

export class PaperTrader {
  private readonly dex = new DexScreenerClient();
  private readonly trackedSells = new Map<string, Array<{ wallet: string; timestamp: number }>>();

  constructor(
    private readonly db: AlphaDb,
    private readonly cfg: Pick<AppConfig, 'maxPaperPositionSol' | 'stopLossPercent' | 'takeProfitMultiples' | 'signalWindowSeconds'>,
    private readonly notifier: Notifier,
  ) {}

  openFromSignal(tokenAddress: string, score: TokenScore, signalId: number): number | null {
    const entry = score.snapshot.priceUsd;
    if (!entry || entry <= 0) return null;
    return this.db.openPaperTrade(tokenAddress, score.symbol, entry, this.cfg.maxPaperPositionSol, signalId, nowSeconds());
  }

  recordTrackedSell(tokenAddress: string, wallet: string, timestamp: number): boolean {
    const cutoff = timestamp - Math.max(600, this.cfg.signalWindowSeconds);
    const active = (this.trackedSells.get(tokenAddress) ?? []).filter(e => e.timestamp >= cutoff && e.wallet !== wallet);
    active.push({ wallet, timestamp });
    this.trackedSells.set(tokenAddress, active);
    const uniqueWallets = new Set(active.map(e => e.wallet));
    return uniqueWallets.size >= 2;
  }

  async emergencyExit(tokenAddress: string, reason: string): Promise<void> {
    const trade = this.db.getOpenTrade(tokenAddress);
    if (!trade) return;
    const snapshot = await this.dex.getBestSnapshot(tokenAddress, null);
    const exitPrice = snapshot?.priceUsd && snapshot.priceUsd > 0 ? snapshot.priceUsd : trade.entryPriceUsd;
    const pnlPercent = ((exitPrice / trade.entryPriceUsd) - 1) * 100;
    this.db.closeTrade(tokenAddress, exitPrice, nowSeconds(), pnlPercent, reason);
    await this.notifier.exit(trade, reason, pnlPercent);
  }

  async updateOpenPositions(): Promise<void> {
    const open = this.db.openTrades();
    for (const trade of open) {
      await this.updateTrade(trade);
    }
  }

  private async updateTrade(trade: PaperTrade): Promise<void> {
    const snapshot = await this.dex.getBestSnapshot(trade.tokenAddress, null).catch(() => null);
    if (!snapshot || !snapshot.priceUsd || snapshot.priceUsd <= 0) return;
    const multiplier = snapshot.priceUsd / trade.entryPriceUsd;
    const pnlPercent = (multiplier - 1) * 100;
    const maxMultiplier = Math.max(trade.maxMultiplier, multiplier);

    let remaining = trade.remainingPercent;
    const [tp1, tp2, tp3] = this.cfg.takeProfitMultiples;
    if (tp1 && multiplier >= tp1 && remaining > 80) remaining = 80;
    if (tp2 && multiplier >= tp2 && remaining > 50) remaining = 50;
    if (tp3 && multiplier >= tp3 && remaining > 20) remaining = 20;
    this.db.updateOpenTrade(trade.tokenAddress, maxMultiplier, remaining);

    if (pnlPercent <= this.cfg.stopLossPercent) {
      this.db.closeTrade(trade.tokenAddress, snapshot.priceUsd, nowSeconds(), pnlPercent, `stop loss ${this.cfg.stopLossPercent}%`);
      await this.notifier.exit({ ...trade, maxMultiplier }, `stop loss ${this.cfg.stopLossPercent}%`, pnlPercent);
    }
  }
}
