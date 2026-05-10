import { describe, expect, it } from 'vitest';
import { calculateWalletVetMetrics, classifyWallet, type WalletVetMetrics } from '../src/walletEvaluator';
import type { WalletSwapEvent } from '../src/types';

function metrics(overrides: Partial<WalletVetMetrics>): WalletVetMetrics {
  return {
    signaturesChecked: 40,
    parsedSwaps: 8,
    buys: 5,
    sells: 3,
    distinctBuyTokens: 4,
    distinctSellTokens: 2,
    avgBuySol: 0.25,
    medianBuySol: 0.2,
    avgSellSol: 0.35,
    medianSellSol: 0.3,
    buySellSizeRatio: 0.71,
    zeroishEvents: 0,
    zeroishRate: 0,
    latestActivityAgeHours: 12,
    latestSwapAgeHours: 12,
    firstSwapAgeHours: 72,
    sampleSpanHours: 60,
    avgHoldMinutes: 45,
    medianHoldMinutes: 40,
    matchedRoundTrips: 3,
    roundTripTokens: 3,
    profitableRoundTripTokens: 2,
    losingRoundTripTokens: 1,
    tokenWinRatePercent: 66.7,
    avgTokenPnlPercent: 30,
    medianTokenPnlPercent: 25,
    largestTokenWinPercent: 120,
    largestTokenLossPercent: -40,
    pnlOutlierShare: 0.45,
    activeTradingStreakDays: 2,
    profitableTokenStreak: 1,
    losingTokenStreak: 0,
    recentSwapCount24h: 3,
    recentBuyCount24h: 2,
    recentSwapShare48h: 0.5,
    sources: ['pumpfun'],
    parseErrors: 0,
    ...overrides,
  };
}

function swap(tokenAddress: string, direction: 'buy' | 'sell', solAmount: number, timestamp: number): WalletSwapEvent {
  return {
    wallet: 'wallet',
    tokenAddress,
    direction,
    solAmount,
    txHash: `${tokenAddress}-${direction}-${timestamp}`,
    timestamp,
    source: 'pumpfun',
  };
}

describe('calculateWalletVetMetrics', () => {
  it('summarizes hold time, sell sizing, token PnL distribution, and current streak from parsed swaps', () => {
    const now = 1_700_000_000;
    const events = [
      swap('tokenA', 'buy', 0.1, now - 3 * 3600),
      swap('tokenA', 'sell', 0.25, now - 2 * 3600),
      swap('tokenB', 'buy', 0.2, now - 90 * 60),
      swap('tokenB', 'sell', 0.1, now - 30 * 60),
      swap('tokenC', 'buy', 0.3, now - 20 * 60),
    ];

    const result = calculateWalletVetMetrics([{ blockTime: now - 60 }], events, 0, now);

    expect(result.avgSellSol).toBeCloseTo(0.175, 6);
    expect(result.medianSellSol).toBeCloseTo(0.175, 6);
    expect(result.buySellSizeRatio).toBeCloseTo(0.6 / 0.35, 6);
    expect(result.avgHoldMinutes).toBeCloseTo(60, 6);
    expect(result.matchedRoundTrips).toBe(2);
    expect(result.roundTripTokens).toBe(2);
    expect(result.profitableRoundTripTokens).toBe(1);
    expect(result.losingRoundTripTokens).toBe(1);
    expect(result.tokenWinRatePercent).toBeCloseTo(50, 6);
    expect(result.largestTokenWinPercent).toBeCloseTo(150, 6);
    expect(result.largestTokenLossPercent).toBeCloseTo(-50, 6);
    expect(result.firstSwapAgeHours).toBeCloseTo(3, 6);
    expect(result.latestSwapAgeHours).toBeCloseTo(20 / 60, 6);
    expect(result.recentSwapCount24h).toBe(5);
    expect(result.recentBuyCount24h).toBe(3);
    expect(result.activeTradingStreakDays).toBe(1);
  });
});

describe('classifyWallet', () => {
  it('keeps recently active wallets with multiple meaningful buys across tokens', () => {
    const result = classifyWallet(metrics({}));

    expect(result.decision).toBe('keep');
    expect(result.score).toBeGreaterThanOrEqual(65);
    expect(result.suggestedTrust).toBeGreaterThanOrEqual(0.5);
  });

  it('rejects sell-only wallets', () => {
    const result = classifyWallet(metrics({ buys: 0, sells: 6, distinctBuyTokens: 0, avgBuySol: 0 }));

    expect(result.decision).toBe('reject');
    expect(result.reasons.join(' ')).toContain('no parsed buys');
  });

  it('keeps narrow repeat-buy wallets out of the automatic keep set', () => {
    const result = classifyWallet(metrics({ buys: 8, sells: 1, distinctBuyTokens: 1, avgBuySol: 1 }));

    expect(result.decision).not.toBe('keep');
    expect(result.reasons.join(' ')).toContain('not enough breadth');
  });

  it('keeps very fast scalpers out of the automatic keep set because the bot cannot follow them reliably', () => {
    const result = classifyWallet(metrics({ avgHoldMinutes: 2, medianHoldMinutes: 2, matchedRoundTrips: 4 }));

    expect(result.decision).not.toBe('keep');
    expect(result.reasons.join(' ')).toContain('too fast to follow');
  });

  it('keeps stale parsed-swap wallets out even when non-swap signatures are recent', () => {
    const result = classifyWallet(metrics({ latestActivityAgeHours: 2, latestSwapAgeHours: 190, recentSwapCount24h: 0, recentBuyCount24h: 0, recentSwapShare48h: 0 }));

    expect(result.decision).toBe('reject');
    expect(result.reasons.join(' ')).toContain('latest parsed swap');
  });

  it('keeps positive-expectancy candidates around a 30% token win rate when followability and breadth are usable', () => {
    const result = classifyWallet(metrics({
      roundTripTokens: 6,
      profitableRoundTripTokens: 2,
      losingRoundTripTokens: 4,
      tokenWinRatePercent: 33.3,
      avgTokenPnlPercent: 12,
      medianTokenPnlPercent: -4,
      largestTokenWinPercent: 180,
      largestTokenLossPercent: -35,
      pnlOutlierShare: 0.55,
    }));

    expect(result.decision).toBe('keep');
    expect(result.reasons.join(' ')).not.toContain('weak token profit distribution');
  });

  it('does not keep active candidates when local round-trip evidence has negative expectancy', () => {
    const result = classifyWallet(metrics({
      roundTripTokens: 6,
      profitableRoundTripTokens: 3,
      losingRoundTripTokens: 3,
      tokenWinRatePercent: 50,
      avgTokenPnlPercent: -6,
      medianTokenPnlPercent: -5,
      largestTokenWinPercent: 30,
      largestTokenLossPercent: -25,
      pnlOutlierShare: 0.35,
    }));

    expect(result.decision).not.toBe('keep');
    expect(result.reasons.join(' ')).toContain('negative token expectancy');
  });

  it('penalizes PnL distributions dominated by one outlier token', () => {
    const result = classifyWallet(metrics({ pnlOutlierShare: 0.9, roundTripTokens: 5, profitableRoundTripTokens: 4, losingRoundTripTokens: 1 }));

    expect(result.decision).not.toBe('keep');
    expect(result.reasons.join(' ')).toContain('one outlier token');
  });
});
