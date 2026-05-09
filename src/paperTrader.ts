import type { AppConfig, ConvergenceSignal, PaperTrade, TokenScore } from './types';
import type { AlphaDb } from './db';
import { DexScreenerClient } from './dexScreener';
import { nowSeconds } from './utils';
import { Notifier } from './notifier';
import { estimatePaperExecution } from './fillSimulator';

export class PaperTrader {
  private readonly dex = new DexScreenerClient();
  private readonly trackedSells = new Map<string, Array<{ wallet: string; timestamp: number }>>();

  constructor(
    private readonly db: AlphaDb,
    private readonly cfg: Pick<AppConfig,
      'maxPaperPositionSol'
      | 'paperSolUsdForEstimates'
      | 'paperComparisonNotionalUsd'
      | 'stopLossPercent'
      | 'takeProfitMultiples'
      | 'paperTrailingStopActivationMultiple'
      | 'paperTrailingStopDrawdownPercent'
      | 'signalWindowSeconds'
    >,
    private readonly notifier: Notifier,
  ) {}

  openFromSignal(tokenAddress: string, score: TokenScore, signalId: number, signal?: ConvergenceSignal): number | null {
    const observed = score.snapshot.priceUsd;
    if (!observed || observed <= 0) return null;
    const fillAt = nowSeconds();
    const execution = estimatePaperExecution(score.snapshot, {
      entrySol: this.cfg.maxPaperPositionSol,
      referenceSolUsd: this.cfg.paperSolUsdForEstimates,
      comparisonNotionalUsd: this.cfg.paperComparisonNotionalUsd,
      signalFirstSeenAt: signal?.firstSeen ?? null,
      signalLastSeenAt: signal?.lastSeen ?? null,
      signalCreatedAt: fillAt,
      fillAt,
    });
    const entry = execution.estimatedFillPriceUsd > 0 ? execution.estimatedFillPriceUsd : observed;
    return this.db.openPaperTrade(tokenAddress, score.symbol, entry, this.cfg.maxPaperPositionSol, signalId, fillAt, execution);
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
    const checkedAt = nowSeconds();

    let remaining = trade.remainingPercent;
    const [tp1, tp2, tp3] = this.cfg.takeProfitMultiples;
    if (tp1 && multiplier >= tp1 && remaining > 80) remaining = 80;
    if (tp2 && multiplier >= tp2 && remaining > 50) remaining = 50;
    if (tp3 && multiplier >= tp3 && remaining > 20) remaining = 20;
    this.db.updateOpenTrade(trade.tokenAddress, maxMultiplier, remaining, {
      priceUsd: snapshot.priceUsd,
      multiplier,
      pnlPercent,
      liquidityUsd: snapshot.liquidityUsd,
      checkedAt,
    });

    if (this.shouldTrailStop(maxMultiplier, multiplier)) {
      const reason = this.trailingStopReason(maxMultiplier, multiplier);
      this.db.closeTrade(trade.tokenAddress, snapshot.priceUsd, checkedAt, pnlPercent, reason);
      await this.notifier.exit({ ...trade, maxMultiplier }, reason, pnlPercent);
      return;
    }

    if (pnlPercent <= this.cfg.stopLossPercent) {
      this.db.closeTrade(trade.tokenAddress, snapshot.priceUsd, checkedAt, pnlPercent, `stop loss ${this.cfg.stopLossPercent}%`);
      await this.notifier.exit({ ...trade, maxMultiplier }, `stop loss ${this.cfg.stopLossPercent}%`, pnlPercent);
    }
  }

  private shouldTrailStop(maxMultiplier: number, multiplier: number): boolean {
    const drawdownPercent = this.trailingDrawdownPercent(maxMultiplier, multiplier);
    return this.cfg.paperTrailingStopDrawdownPercent > 0
      && maxMultiplier >= this.cfg.paperTrailingStopActivationMultiple
      && drawdownPercent >= this.cfg.paperTrailingStopDrawdownPercent;
  }

  private trailingStopReason(maxMultiplier: number, multiplier: number): string {
    const drawdownPercent = this.trailingDrawdownPercent(maxMultiplier, multiplier);
    return `trailing stop ${formatReasonPercent(this.cfg.paperTrailingStopDrawdownPercent)} peak drawdown (peak ${maxMultiplier.toFixed(2)}x → current ${multiplier.toFixed(2)}x, drawdown -${drawdownPercent.toFixed(1)}%)`;
  }

  private trailingDrawdownPercent(maxMultiplier: number, multiplier: number): number {
    if (maxMultiplier <= 0) return 0;
    return Math.max(0, (1 - multiplier / maxMultiplier) * 100);
  }
}

function formatReasonPercent(value: number): string {
  return Math.abs(value - Math.round(value)) < 0.05 ? `${Math.round(value)}%` : `${value.toFixed(1)}%`;
}
