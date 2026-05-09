import { describe, expect, it } from 'vitest';
import { buildWalletPerformance } from '../src/walletPerformance';
import type { WalletConfig, WalletSignalAttributionRow } from '../src/types';

const wallets: WalletConfig[] = [
  { address: 'walletA11111111111111111111111111111111111', label: 'alpha_a', trust: 0.55, enabled: true },
  { address: 'walletB22222222222222222222222222222222222', label: 'alpha_b', trust: 0.6, enabled: true },
  { address: 'walletC33333333333333333333333333333333333', label: 'alpha_c', trust: 0.5, enabled: true },
];

function row(overrides: Partial<WalletSignalAttributionRow>): WalletSignalAttributionRow {
  return {
    signalId: 1,
    tokenAddress: 'Token111111111111111111111111111111111111',
    symbol: 'TOK',
    pass: true,
    compositeScore: 70,
    walletsJson: JSON.stringify([{ wallet: 'walletA11111111111111111111111111111111111', trust: 0.55, timestamp: 1_700_000_000 }]),
    createdAt: 1_700_000_010,
    tradeId: 1,
    tradeStatus: 'closed',
    entrySol: 0.1,
    remainingPercent: 0,
    pnlPercent: 20,
    lastPnlPercent: null,
    estimatedSlippageBps: 12,
    latestWalletToFillSeconds: 8,
    signalToFillSeconds: 0,
    exitTime: 1_700_000_300,
    ...overrides,
  };
}

describe('buildWalletPerformance', () => {
  it('attributes signal/trade outcomes to each participating wallet and recommends trust changes', () => {
    const rows = [
      row({ signalId: 1, tradeId: 1, symbol: 'WIN1', walletsJson: JSON.stringify([{ wallet: wallets[0].address }, { wallet: wallets[1].address }]), pnlPercent: 40, estimatedSlippageBps: 10, latestWalletToFillSeconds: 5, exitTime: 1_700_000_500 }),
      row({ signalId: 2, tradeId: 2, symbol: 'WIN2', walletsJson: JSON.stringify([{ wallet: wallets[0].address }, { wallet: wallets[1].address }]), pnlPercent: 25, estimatedSlippageBps: 20, latestWalletToFillSeconds: 7, exitTime: 1_700_000_600 }),
      row({ signalId: 3, tradeId: 3, symbol: 'WIN3', walletsJson: JSON.stringify([{ wallet: wallets[0].address }]), pnlPercent: 10, estimatedSlippageBps: 15, latestWalletToFillSeconds: 9, exitTime: 1_700_000_700 }),
      row({ signalId: 4, tradeId: 4, symbol: 'LOSS1', walletsJson: JSON.stringify([{ wallet: wallets[1].address }, { wallet: wallets[2].address }]), pnlPercent: -30, estimatedSlippageBps: 30, latestWalletToFillSeconds: 12, exitTime: 1_700_000_800 }),
      row({ signalId: 5, tradeId: 5, symbol: 'LOSS2', walletsJson: JSON.stringify([{ wallet: wallets[1].address }, { wallet: wallets[2].address }]), pnlPercent: -35, estimatedSlippageBps: 40, latestWalletToFillSeconds: 16, exitTime: 1_700_000_900 }),
      row({ signalId: 6, tradeId: 6, symbol: 'OPEN', walletsJson: JSON.stringify([{ wallet: wallets[2].address }]), tradeStatus: 'open', pnlPercent: null, lastPnlPercent: 12, entrySol: 0.1, remainingPercent: 80, estimatedSlippageBps: 50, latestWalletToFillSeconds: 20, exitTime: null }),
      row({ signalId: 7, symbol: 'SKIP', pass: false, tradeId: null, tradeStatus: null, pnlPercent: null, lastPnlPercent: null, entrySol: null, remainingPercent: null, walletsJson: JSON.stringify([{ wallet: wallets[2].address }]) }),
    ];

    const [a, b, c] = buildWalletPerformance(rows, wallets, { limit: 10 });

    expect(a.label).toBe('alpha_a');
    expect(a.signals).toBe(3);
    expect(a.passedSignals).toBe(3);
    expect(a.paperTrades).toBe(3);
    expect(a.closedTrades).toBe(3);
    expect(a.winRatePercent).toBeCloseTo(100, 6);
    expect(a.avgPnlPercent).toBeCloseTo(25, 6);
    expect(a.medianPnlPercent).toBeCloseTo(25, 6);
    expect(a.avgSlippageBps).toBeCloseTo(15, 6);
    expect(a.avgLatestWalletToFillSeconds).toBeCloseTo(7, 6);
    expect(a.recommendation).toBe('promote');
    expect(a.suggestedTrust).toBeCloseTo(0.6, 6);

    expect(b.recommendation).toBe('probation');
    expect(b.badSignalStreak).toBe(2);
    expect(b.avgPnlPercent).toBeCloseTo(0, 6);

    expect(c.openTrades).toBe(1);
    expect(c.openExposureSol).toBeCloseTo(0.08, 6);
    expect(c.recommendation).toBe('demote');
    expect(c.reason).toContain('closed losses');
  });

  it('deduplicates repeated wallet entries inside the same signal attribution', () => {
    const [perf] = buildWalletPerformance([
      row({
        walletsJson: JSON.stringify([{ wallet: wallets[0].address }, { wallet: wallets[0].address }]),
      }),
    ], wallets, { limit: 10 });

    expect(perf.signals).toBe(1);
    expect(perf.paperTrades).toBe(1);
  });
});
