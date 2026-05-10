import type { WalletConfig, WalletPerformance, WalletPerformanceRecommendation, WalletSignalAttributionRow } from './types';

interface WorkingWalletStats {
  address: string;
  label: string;
  currentTrust: number | null;
  signalIds: Set<number>;
  passedSignalIds: Set<number>;
  tradeIds: Set<number>;
  closedTradeIds: Set<number>;
  openTradeIds: Set<number>;
  closedPnl: Array<{ pnl: number; exitTime: number }>;
  adverseExitCount: number;
  slippageBps: number[];
  latestWalletToFillSeconds: number[];
  signalToFillSeconds: number[];
  openExposureSol: number;
  sampleSymbols: string[];
}

interface ParsedSignalWallet {
  address: string;
  label?: string;
  trust?: number;
}

export interface BuildWalletPerformanceOptions {
  limit?: number;
}

export function buildWalletPerformance(
  rows: WalletSignalAttributionRow[],
  wallets: WalletConfig[],
  options: BuildWalletPerformanceOptions = {},
): WalletPerformance[] {
  const configured = new Map(wallets.map(wallet => [wallet.address, wallet]));
  const byWallet = new Map<string, WorkingWalletStats>();

  for (const row of rows) {
    const seen = new Set<string>();
    for (const wallet of parseSignalWallets(row.walletsJson)) {
      if (seen.has(wallet.address)) continue;
      seen.add(wallet.address);

      const stats = getOrCreateStats(byWallet, configured, wallet);
      stats.signalIds.add(row.signalId);
      if (row.pass) stats.passedSignalIds.add(row.signalId);
      addSampleSymbol(stats.sampleSymbols, row.symbol);

      if (row.tradeId != null) {
        const tradeId = Number(row.tradeId);
        if (!stats.tradeIds.has(tradeId)) {
          stats.tradeIds.add(tradeId);
          if (row.estimatedSlippageBps != null && Number.isFinite(row.estimatedSlippageBps)) stats.slippageBps.push(Number(row.estimatedSlippageBps));
          if (row.latestWalletToFillSeconds != null && Number.isFinite(row.latestWalletToFillSeconds)) stats.latestWalletToFillSeconds.push(Number(row.latestWalletToFillSeconds));
          if (row.signalToFillSeconds != null && Number.isFinite(row.signalToFillSeconds)) stats.signalToFillSeconds.push(Number(row.signalToFillSeconds));
        }

        if (row.tradeStatus === 'closed' && !stats.closedTradeIds.has(tradeId)) {
          stats.closedTradeIds.add(tradeId);
          if (row.pnlPercent != null && Number.isFinite(row.pnlPercent)) {
            stats.closedPnl.push({ pnl: Number(row.pnlPercent), exitTime: row.exitTime ?? row.createdAt });
          }
          if (isAdverseExitReason(row.exitReason)) stats.adverseExitCount += 1;
        }

        if (row.tradeStatus === 'open' && !stats.openTradeIds.has(tradeId)) {
          stats.openTradeIds.add(tradeId);
          const entrySol = row.entrySol == null || !Number.isFinite(row.entrySol) ? 0 : Number(row.entrySol);
          const remaining = row.remainingPercent == null || !Number.isFinite(row.remainingPercent) ? 100 : Number(row.remainingPercent);
          stats.openExposureSol += entrySol * Math.max(0, Math.min(1, remaining / 100));
        }
      }
    }
  }

  const result = Array.from(byWallet.values()).map(toWalletPerformance);
  result.sort((a, b) => {
    const aSample = a.closedTrades > 0 ? 1 : 0;
    const bSample = b.closedTrades > 0 ? 1 : 0;
    return bSample - aSample || b.alphaScore - a.alphaScore || b.paperTrades - a.paperTrades || b.passedSignals - a.passedSignals || b.signals - a.signals || a.label.localeCompare(b.label);
  });
  return options.limit == null ? result : result.slice(0, options.limit);
}

function parseSignalWallets(walletsJson: string): ParsedSignalWallet[] {
  try {
    const parsed = JSON.parse(walletsJson) as Array<{ wallet?: unknown; address?: unknown; label?: unknown; trust?: unknown }>;
    if (!Array.isArray(parsed)) return [];
    const wallets: ParsedSignalWallet[] = [];
    for (const item of parsed) {
      const address = String(item.wallet ?? item.address ?? '').trim();
      if (!address) continue;
      const trust = typeof item.trust === 'number' && Number.isFinite(item.trust) ? item.trust : undefined;
      const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim() : undefined;
      wallets.push({ address, label, trust });
    }
    return wallets;
  } catch {
    return [];
  }
}

function isAdverseExitReason(reason: unknown): boolean {
  if (typeof reason !== 'string') return false;
  return /stop loss|tracked wallets sold|emergency/i.test(reason);
}

function getOrCreateStats(
  byWallet: Map<string, WorkingWalletStats>,
  configured: Map<string, WalletConfig>,
  wallet: ParsedSignalWallet,
): WorkingWalletStats {
  const existing = byWallet.get(wallet.address);
  if (existing) return existing;
  const cfg = configured.get(wallet.address);
  const stats: WorkingWalletStats = {
    address: wallet.address,
    label: cfg?.label ?? wallet.label ?? shortWallet(wallet.address),
    currentTrust: typeof cfg?.trust === 'number' && Number.isFinite(cfg.trust) ? cfg.trust : (wallet.trust ?? null),
    signalIds: new Set(),
    passedSignalIds: new Set(),
    tradeIds: new Set(),
    closedTradeIds: new Set(),
    openTradeIds: new Set(),
    closedPnl: [],
    adverseExitCount: 0,
    slippageBps: [],
    latestWalletToFillSeconds: [],
    signalToFillSeconds: [],
    openExposureSol: 0,
    sampleSymbols: [],
  };
  byWallet.set(wallet.address, stats);
  return stats;
}

function toWalletPerformance(stats: WorkingWalletStats): WalletPerformance {
  const signals = stats.signalIds.size;
  const passedSignals = stats.passedSignalIds.size;
  const pnlValues = stats.closedPnl.map(item => item.pnl);
  const winRatePercent = pnlValues.length > 0 ? (pnlValues.filter(value => value > 0).length / pnlValues.length) * 100 : null;
  const avgPnlPercent = averageOrNull(pnlValues);
  const medianPnlPercent = medianOrNull(pnlValues);
  const badSignalStreak = calculateBadSignalStreak(stats.closedPnl);
  const alphaScore = calculateAlphaScore({ signals, passedSignals, closedTrades: stats.closedTradeIds.size, winRatePercent, avgPnlPercent, badSignalStreak, avgSlippageBps: averageOrNull(stats.slippageBps) });
  const { recommendation, suggestedTrust, reason } = recommendWallet(stats.currentTrust, {
    closedTrades: stats.closedTradeIds.size,
    winRatePercent,
    avgPnlPercent,
    medianPnlPercent,
    badSignalStreak,
    adverseExitCount: stats.adverseExitCount,
    alphaScore,
  });

  return {
    address: stats.address,
    label: stats.label,
    currentTrust: stats.currentTrust,
    suggestedTrust,
    signals,
    passedSignals,
    passRatePercent: signals > 0 ? (passedSignals / signals) * 100 : null,
    paperTrades: stats.tradeIds.size,
    closedTrades: stats.closedTradeIds.size,
    openTrades: stats.openTradeIds.size,
    openExposureSol: stats.openExposureSol,
    winRatePercent,
    avgPnlPercent,
    medianPnlPercent,
    avgSlippageBps: averageOrNull(stats.slippageBps),
    avgLatestWalletToFillSeconds: averageOrNull(stats.latestWalletToFillSeconds),
    avgSignalToFillSeconds: averageOrNull(stats.signalToFillSeconds),
    badSignalStreak,
    recommendation,
    alphaScore,
    reason,
    sampleSymbols: stats.sampleSymbols,
  };
}

function calculateAlphaScore(input: {
  signals: number;
  passedSignals: number;
  closedTrades: number;
  winRatePercent: number | null;
  avgPnlPercent: number | null;
  badSignalStreak: number;
  avgSlippageBps: number | null;
}): number {
  const passRate = input.signals > 0 ? (input.passedSignals / input.signals) * 100 : 0;
  let score = 45;
  score += Math.min(12, input.signals * 0.8);
  score += Math.min(10, input.closedTrades * 2);
  score += Math.min(12, passRate * 0.12);
  if (input.winRatePercent != null) score += (input.winRatePercent - 50) * 0.35;
  if (input.avgPnlPercent != null) score += input.avgPnlPercent * 0.8;
  if (input.avgSlippageBps != null && input.avgSlippageBps > 100) score -= Math.min(10, (input.avgSlippageBps - 100) / 50);
  score -= input.badSignalStreak * 4;
  return Math.round(clamp(score, 0, 100));
}

function recommendWallet(
  currentTrust: number | null,
  metrics: {
    closedTrades: number;
    winRatePercent: number | null;
    avgPnlPercent: number | null;
    medianPnlPercent: number | null;
    badSignalStreak: number;
    adverseExitCount: number;
    alphaScore: number;
  },
): { recommendation: WalletPerformanceRecommendation; suggestedTrust: number | null; reason: string } {
  const trust = currentTrust ?? 0.5;
  const win = metrics.winRatePercent;
  const avg = metrics.avgPnlPercent;
  const median = metrics.medianPnlPercent;
  const repeatedAdverseExits = metrics.adverseExitCount >= 2;
  let recommendation: WalletPerformanceRecommendation = 'keep';
  let reason = 'sample usable; keep current trust';

  if (metrics.closedTrades < 2) {
    recommendation = 'keep';
    reason = 'thin closed-trade sample; keep observing';
  } else if (
    metrics.closedTrades >= 8
    && avg != null
    && win != null
    && avg < 0
    && win < 25
    && (metrics.badSignalStreak >= 4 || metrics.adverseExitCount >= 4)
  ) {
    recommendation = 'disable_candidate';
    reason = 'persistent negative expectancy with weak win rate and repeated losses/adverse exits';
  } else if (metrics.closedTrades >= 2 && repeatedAdverseExits) {
    recommendation = 'demote';
    reason = 'repeated stop/emergency exits; lower tier until signals improve';
  } else if (metrics.closedTrades >= 2 && avg != null && avg < 0) {
    recommendation = 'demote';
    reason = 'closed losses and negative expectancy across paper trades';
  } else if (metrics.closedTrades >= 2 && win != null && win < 25) {
    recommendation = 'demote';
    reason = 'paper win rate below 25%; demote despite any outlier gains';
  } else if (metrics.badSignalStreak >= 2) {
    recommendation = 'probation';
    reason = 'recent losing streak; require better next signals';
  } else if (metrics.closedTrades < 5) {
    recommendation = 'keep';
    reason = 'positive but thin closed-trade sample; need 5 closed trades before promotion';
  } else if (avg != null && avg < 8) {
    recommendation = 'probation';
    reason = 'positive sample not yet strong enough for promotion';
  } else if (metrics.closedTrades >= 5 && win != null && win < 30) {
    recommendation = 'probation';
    reason = 'paper win rate below 30%; keep observing before promotion';
  } else if (
    metrics.closedTrades >= 5
    && avg != null
    && avg >= 8
    && win != null
    && win >= 30
    && metrics.badSignalStreak <= 2
  ) {
    recommendation = 'promote';
    if (avg >= 15 && win >= 35 && (median == null || median >= -5)) {
      reason = 'strong positive expectancy with 35%+ win rate and median PnL near positive';
    } else {
      reason = 'positive expectancy with 30%+ win rate and controlled bad streak';
    }
  }

  return { recommendation, suggestedTrust: suggestedTrustFor(recommendation, trust), reason };
}

function suggestedTrustFor(recommendation: WalletPerformanceRecommendation, currentTrust: number): number | null {
  if (recommendation === 'disable_candidate') return 0;
  if (recommendation === 'demote') return roundTrust(clamp(currentTrust - 0.1, 0.1, 1));
  if (recommendation === 'probation') return roundTrust(clamp(currentTrust - 0.05, 0.1, 1));
  if (recommendation === 'promote') return roundTrust(clamp(currentTrust + 0.05, 0.1, 1));
  return roundTrust(currentTrust);
}

function calculateBadSignalStreak(closedPnl: Array<{ pnl: number; exitTime: number }>): number {
  const sorted = [...closedPnl].sort((a, b) => b.exitTime - a.exitTime);
  let streak = 0;
  for (const item of sorted) {
    if (item.pnl > 0) break;
    streak += 1;
  }
  return streak;
}

function addSampleSymbol(symbols: string[], symbol: string): void {
  if (!symbol || symbols.includes(symbol) || symbols.length >= 5) return;
  symbols.push(symbol);
}

function averageOrNull(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function medianOrNull(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundTrust(value: number): number {
  return Math.round(value * 100) / 100;
}

function shortWallet(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
