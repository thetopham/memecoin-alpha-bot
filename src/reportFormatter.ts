import type { PaperTrade, WalletPerformance } from './types';
import { formatUsd, shortAddress } from './utils';

interface SignalSnapshotLike {
  liquidityUsd?: unknown;
  dexId?: unknown;
  url?: unknown;
  tokenAddress?: unknown;
  marketStage?: unknown;
}

export function normalizeSignalReasonText(text: string, scoreJson?: string | null): string {
  if (!text.includes('liquidity too thin at $0')) return text;
  const snapshot = parseScoreSnapshot(scoreJson);
  const replacement = snapshotLooksPreGraduation(snapshot)
    ? 'DEX liquidity unavailable / likely pre-graduation'
    : 'DEX liquidity unavailable / no usable pool';
  return text.split('liquidity too thin at $0').join(replacement);
}

function parseScoreSnapshot(scoreJson?: string | null): SignalSnapshotLike | null {
  if (!scoreJson) return null;
  try {
    const parsed = JSON.parse(scoreJson) as { snapshot?: SignalSnapshotLike };
    return parsed?.snapshot ?? null;
  } catch {
    return null;
  }
}

function snapshotLooksPreGraduation(snapshot: SignalSnapshotLike | null): boolean {
  if (!snapshot) return false;
  const liquidityUsd = typeof snapshot.liquidityUsd === 'number' ? snapshot.liquidityUsd : Number(snapshot.liquidityUsd ?? 0);
  if (!Number.isFinite(liquidityUsd) || liquidityUsd > 0) return false;
  const dexId = String(snapshot.dexId ?? '').toLowerCase();
  const url = String(snapshot.url ?? '').toLowerCase();
  const tokenAddress = String(snapshot.tokenAddress ?? '').toLowerCase();
  return snapshot.marketStage === 'pumpfun_bonding_curve' || dexId.includes('pump') || url.includes('pump.fun') || tokenAddress.endsWith('pump');
}

export interface OpenPositionFormatOptions {
  now: number;
  stopLossPercent: number;
  takeProfitMultiples: number[];
}

const TAKE_PROFIT_REMAINING = [80, 50, 20];

export function formatOpenPositions(open: PaperTrade[], options: OpenPositionFormatOptions): string {
  if (open.length === 0) return 'No open paper trades.';

  return [
    'Open paper trades:',
    ...open.map(trade => formatOpenPosition(trade, options)),
  ].join('\n');
}

export function formatPaperPortfolioSummary(open: PaperTrade[], closed: PaperTrade[], options: OpenPositionFormatOptions): string {
  const realizedSol = closed.reduce((sum, trade) => sum + estimateTradePnlSol(trade, options), 0);
  const unrealizedSol = open.reduce((sum, trade) => sum + estimateTradePnlSol(trade, options), 0);
  const totalSol = realizedSol + unrealizedSol;
  const closedPcts = closed.map(trade => estimateTradePnlPercent(trade, options)).filter((value): value is number => value != null);
  const avgClosedPct = closedPcts.length > 0 ? closedPcts.reduce((sum, value) => sum + value, 0) / closedPcts.length : null;
  const wins = closedPcts.filter(value => value > 0).length;
  const winRate = closedPcts.length > 0 ? (wins / closedPcts.length) * 100 : null;
  const openBasisSol = open.reduce((sum, trade) => sum + trade.entrySol * remainingFraction(trade), 0);
  const openPct = openBasisSol > 0 ? (unrealizedSol / openBasisSol) * 100 : null;

  return [
    'Paper PnL summary:',
    `realized closed PnL: ${formatSignedSol(realizedSol)} (${avgClosedPct == null ? 'n/a avg' : `${formatSignedPct(avgClosedPct)} avg`}, ${winRate == null ? 'n/a win rate' : `${winRate.toFixed(1)}% win rate`})`,
    `unrealized open PnL: ${formatSignedSol(unrealizedSol)} (${openPct == null ? 'n/a' : `${formatSignedPct(openPct)} on remaining inventory`})`,
    `estimated total PnL: ${formatSignedSol(totalSol)}`,
    'note: PnL is simulated; take-profit proceeds are inferred from the configured paper ladder.',
  ].join('\n');
}

export function formatWalletPerformance(wallets: WalletPerformance[], limit = 8): string {
  const rows = wallets.slice(0, limit);
  if (rows.length === 0) return 'No wallet performance history yet.';
  return [
    'Wallet Alpha Scoreboard:',
    ...rows.map((wallet, idx) => formatWalletPerformanceRow(wallet, idx + 1)),
    'note: attribution is per signal participant; multi-wallet trades credit/blame each participating wallet.',
  ].join('\n');
}

function formatWalletPerformanceRow(wallet: WalletPerformance, rank: number): string {
  const passRate = wallet.passRatePercent == null ? 'n/a' : `${wallet.passRatePercent.toFixed(1)}%`;
  const winRate = wallet.winRatePercent == null ? 'n/a' : `${wallet.winRatePercent.toFixed(1)}%`;
  const avgPnl = wallet.avgPnlPercent == null ? 'n/a' : `${formatSignedPct(wallet.avgPnlPercent)} avg`;
  const medianPnl = wallet.medianPnlPercent == null ? 'n/a median' : `${formatSignedPct(wallet.medianPnlPercent)} median`;
  const avgSlip = wallet.avgSlippageBps == null ? 'n/a avg slip' : `${formatSignedBps(wallet.avgSlippageBps)} avg slip`;
  const latency = wallet.avgLatestWalletToFillSeconds == null ? 'latest wallet→fill avg n/a' : `latest wallet→fill avg ${formatDuration(wallet.avgLatestWalletToFillSeconds)}`;
  const signalLatency = wallet.avgSignalToFillSeconds == null ? '' : ` | signal→fill avg ${formatDuration(wallet.avgSignalToFillSeconds)}`;
  const trust = formatTrustLine(wallet);
  const symbols = wallet.sampleSymbols.length === 0 ? '' : ` | sample: ${wallet.sampleSymbols.join(', ')}`;
  return [
    `#${rank} ${wallet.label} ${shortAddress(wallet.address)} — ${wallet.recommendation} | alpha ${wallet.alphaScore}/100`,
    `  signals: ${wallet.signals} total | ${wallet.passedSignals} passed (${passRate}) | trades: ${wallet.paperTrades} paper / ${wallet.closedTrades} closed / ${wallet.openTrades} open`,
    `  closed PnL: ${avgPnl} | ${medianPnl} | ${winRate} win | bad streak ${wallet.badSignalStreak}`,
    `  exec: ${avgSlip} | ${latency}${signalLatency}`,
    `  trust: ${trust} | open exposure ${wallet.openExposureSol.toFixed(3)} SOL | reason: ${wallet.reason}${symbols}`,
  ].join('\n');
}

function formatTrustLine(wallet: WalletPerformance): string {
  const current = wallet.currentTrust == null ? 'n/a' : wallet.currentTrust.toFixed(2);
  const suggested = wallet.suggestedTrust == null ? 'n/a' : wallet.suggestedTrust.toFixed(2);
  return `${current} → ${suggested} suggested`;
}

export function formatClosedPositions(closed: PaperTrade[], options: OpenPositionFormatOptions, limit = 8): string {
  const recent = closed.slice(0, limit);
  if (recent.length === 0) return 'No closed paper trades yet.';
  return [
    'Recent closed paper trades:',
    ...recent.map(trade => formatClosedPosition(trade, options)),
  ].join('\n');
}

function formatClosedPosition(trade: PaperTrade, options: OpenPositionFormatOptions): string {
  const signal = trade.signalId == null ? 'no signal id' : `signal #${trade.signalId}`;
  const exitPrice = trade.exitPriceUsd == null ? 'n/a' : formatUsdPrice(trade.exitPriceUsd);
  const exitTime = trade.exitTime ?? options.now;
  const held = formatDuration(exitTime - trade.entryTime);
  const closedAgo = formatDuration(options.now - exitTime);
  const pnlPercent = estimateTradePnlPercent(trade, options);
  const pnlSol = estimateTradePnlSol(trade, options);
  const reason = trade.exitReason || 'n/a';

  return [
    `#${trade.id} $${trade.symbol} — PAPER CLOSED`,
    `  size: ${trade.entrySol.toFixed(3)} SOL simulated | realized: ${pnlPercent == null ? 'n/a' : formatSignedPct(pnlPercent)} (${formatSignedSol(pnlSol)} est)`,
    `  entry: ${formatUsdPrice(trade.entryPriceUsd)} → exit: ${exitPrice} (held ${held})`,
    ...formatExecutionLines(trade),
    `  peak: ${trade.maxMultiplier.toFixed(2)}x | reason: ${reason}`,
    `  token: ${shortAddress(trade.tokenAddress)} | ${signal} | closed ${closedAgo} ago`,
  ].join('\n');
}

function estimateTradePnlPercent(trade: PaperTrade, options: OpenPositionFormatOptions): number | null {
  const sol = estimateTradePnlSol(trade, options);
  if (!Number.isFinite(sol) || trade.entrySol <= 0) return null;
  return (sol / trade.entrySol) * 100;
}

function estimateTradePnlSol(trade: PaperTrade, options: OpenPositionFormatOptions): number {
  const takeProfitRealized = estimateTakeProfitPnlSol(trade, options);
  const multiplier = tradeMultiplier(trade);
  if (multiplier == null) return takeProfitRealized;
  const finalFraction = trade.status === 'closed'
    ? remainingFractionAfterTriggeredTakeProfits(trade.maxMultiplier, options.takeProfitMultiples)
    : remainingFraction(trade);
  return takeProfitRealized + trade.entrySol * finalFraction * (multiplier - 1);
}

function estimateTakeProfitPnlSol(trade: PaperTrade, options: OpenPositionFormatOptions): number {
  let previousRemaining = 1;
  let pnl = 0;
  for (let idx = 0; idx < options.takeProfitMultiples.length; idx += 1) {
    const multiple = options.takeProfitMultiples[idx];
    const targetRemaining = (TAKE_PROFIT_REMAINING[idx] ?? 0) / 100;
    const triggered = trade.maxMultiplier >= multiple && (trade.status === 'closed' || trade.remainingPercent <= (TAKE_PROFIT_REMAINING[idx] ?? 0));
    if (triggered && targetRemaining < previousRemaining) {
      const soldFraction = previousRemaining - targetRemaining;
      pnl += trade.entrySol * soldFraction * (multiple - 1);
      previousRemaining = targetRemaining;
    }
  }
  return pnl;
}

function remainingFractionAfterTriggeredTakeProfits(maxMultiplier: number, takeProfitMultiples: number[]): number {
  let remaining = 1;
  for (let idx = 0; idx < takeProfitMultiples.length; idx += 1) {
    if (maxMultiplier >= takeProfitMultiples[idx]) remaining = (TAKE_PROFIT_REMAINING[idx] ?? 0) / 100;
  }
  return remaining;
}

function tradeMultiplier(trade: PaperTrade): number | null {
  if (trade.status === 'closed') {
    if (trade.pnlPercent != null && Number.isFinite(trade.pnlPercent)) return 1 + trade.pnlPercent / 100;
    if (trade.exitPriceUsd != null && trade.entryPriceUsd > 0) return trade.exitPriceUsd / trade.entryPriceUsd;
    return null;
  }
  if (trade.lastMultiplier != null && Number.isFinite(trade.lastMultiplier)) return trade.lastMultiplier;
  return multiplierFromPrice(trade);
}

function remainingFraction(trade: PaperTrade): number {
  return Math.max(0, Math.min(1, trade.remainingPercent / 100));
}

function formatSignedSol(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(3)} SOL`;
}

function formatOpenPosition(trade: PaperTrade, options: OpenPositionFormatOptions): string {
  const signal = trade.signalId == null ? 'no signal id' : `signal #${trade.signalId}`;
  const current = formatCurrentLine(trade);
  const peak = formatPeakLine(trade);
  const lastCheck = trade.lastCheckedAt == null ? 'never' : `${formatDuration(options.now - trade.lastCheckedAt)} ago`;

  return [
    `#${trade.id} $${trade.symbol} — PAPER OPEN`,
    `  size: ${trade.entrySol.toFixed(3)} SOL simulated | remaining: ${trade.remainingPercent.toFixed(1)}%`,
    `  entry: ${formatUsdPrice(trade.entryPriceUsd)} (opened ${formatDuration(options.now - trade.entryTime)} ago via ${signal})`,
    ...formatExecutionLines(trade),
    `  ${current}`,
    `  ${peak}`,
    `  exits: stop ${options.stopLossPercent.toFixed(1)}%; take-profits ${formatTakeProfits(options.takeProfitMultiples)}`,
    `  token: ${shortAddress(trade.tokenAddress)} | last check: ${lastCheck}`,
  ].join('\n');
}

function formatExecutionLines(trade: PaperTrade): string[] {
  if (trade.observedPriceUsd == null || trade.estimatedFillPriceUsd == null || trade.estimatedSlippageBps == null) {
    return [];
  }

  const lines = [
    `  execution: observed ${formatUsdPrice(trade.observedPriceUsd)} → est fill ${formatUsdPrice(trade.estimatedFillPriceUsd)} (${formatSignedBps(trade.estimatedSlippageBps)}) | size ≈ ${formatNotionalUsd(trade.estimatedNotionalUsd)}`,
  ];

  if (trade.comparisonNotionalUsd != null && trade.comparisonSlippageBps != null) {
    lines.push(`  ${formatNotionalUsd(trade.comparisonNotionalUsd)} size check: est slippage ${formatSignedBps(trade.comparisonSlippageBps)}`);
  }

  const latency = formatLatencyLine(trade);
  if (latency) lines.push(`  ${latency}`);

  if (trade.fillModel) {
    const source = trade.fillSource || 'unknown';
    const confidence = trade.liquidityConfidence && trade.liquidityConfidence !== 'high'
      ? ` | ${trade.liquidityConfidence} confidence${trade.liquidityBasis ? ` (${trade.liquidityBasis})` : ''}`
      : '';
    lines.push(`  model: ${trade.fillModel} via ${source}${confidence}`);
  }

  return lines;
}

function formatLatencyLine(trade: PaperTrade): string | null {
  const parts: string[] = [];
  if (trade.latestWalletToFillSeconds != null) parts.push(`latest wallet→fill ${formatDuration(trade.latestWalletToFillSeconds)}`);
  if (trade.firstWalletToFillSeconds != null) parts.push(`first wallet→fill ${formatDuration(trade.firstWalletToFillSeconds)}`);
  if (trade.signalToFillSeconds != null) parts.push(`signal→fill ${formatDuration(trade.signalToFillSeconds)}`);
  return parts.length > 0 ? `latency: ${parts.join(' | ')}` : null;
}

function formatCurrentLine(trade: PaperTrade): string {
  const currentPrice = trade.lastPriceUsd;
  const multiplier = trade.lastMultiplier ?? multiplierFromPrice(trade);
  const pnlPercent = trade.lastPnlPercent ?? (multiplier == null ? null : (multiplier - 1) * 100);
  if (currentPrice == null || multiplier == null || pnlPercent == null) {
    return 'current: n/a (no DexScreener price captured yet)';
  }
  const liq = trade.lastLiquidityUsd == null ? 'liq: n/a' : `liq: ${formatUsd(trade.lastLiquidityUsd)}`;
  return `current: ${formatUsdPrice(currentPrice)} = ${multiplier.toFixed(2)}x (${formatSignedPct(pnlPercent)}) | ${liq}`;
}

function formatPeakLine(trade: PaperTrade): string {
  const multiplier = trade.lastMultiplier ?? multiplierFromPrice(trade);
  if (multiplier == null || trade.maxMultiplier <= 0) return `peak: ${trade.maxMultiplier.toFixed(2)}x`;
  const drawdown = Math.min(0, (multiplier / trade.maxMultiplier - 1) * 100);
  return `peak: ${trade.maxMultiplier.toFixed(2)}x | drawdown from peak: ${formatDrawdownPct(drawdown)}`;
}

function multiplierFromPrice(trade: PaperTrade): number | null {
  if (trade.lastPriceUsd == null || trade.entryPriceUsd <= 0) return null;
  return trade.lastPriceUsd / trade.entryPriceUsd;
}

function formatTakeProfits(multiples: number[]): string {
  if (multiples.length === 0) return 'none configured';
  return multiples.map((multiple, idx) => `${formatMultiple(multiple)}→${TAKE_PROFIT_REMAINING[idx] ?? 0}%`).join(', ');
}

function formatMultiple(value: number): string {
  return Number.isInteger(value) ? `${value}x` : `${value.toFixed(2)}x`;
}

function formatSignedBps(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(1)} bps`;
}

function formatNotionalUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  if (Math.abs(value - Math.round(value)) < 0.005) return `$${Math.round(value)}`;
  if (Math.abs(value) < 1_000) return `$${value.toFixed(2)}`;
  return formatUsd(value);
}

function formatSignedPct(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

function formatDrawdownPct(value: number): string {
  return value === 0 ? '0.0%' : `${value.toFixed(1)}%`;
}

function formatDuration(secondsRaw: number): string {
  const seconds = Math.max(0, Math.floor(secondsRaw));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w`;
}

function formatUsdPrice(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  if (value === 0) return '$0';
  if (Math.abs(value) < 0.0001) return `$${value.toFixed(10)}`;
  if (Math.abs(value) < 0.01) return `$${value.toFixed(8)}`;
  if (Math.abs(value) < 1) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(2)}`;
}
