import { describe, expect, it } from 'vitest';
import { classifyWallet, type WalletVetMetrics } from '../src/walletEvaluator';

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
    zeroishEvents: 0,
    zeroishRate: 0,
    latestActivityAgeHours: 12,
    sources: ['pumpfun'],
    parseErrors: 0,
    ...overrides,
  };
}

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
});
