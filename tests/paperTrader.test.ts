import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaperTrade } from '../src/types';

const mockState = vi.hoisted(() => ({
  snapshots: [] as Array<{ priceUsd: number; liquidityUsd: number }>,
}));

vi.mock('../src/dexScreener', () => ({
  DexScreenerClient: vi.fn().mockImplementation(() => ({
    getBestSnapshot: vi.fn(async () => mockState.snapshots.shift() ?? null),
  })),
}));

vi.mock('../src/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/utils')>();
  return {
    ...actual,
    nowSeconds: () => 1_700_000_123,
  };
});

import { PaperTrader } from '../src/paperTrader';

function makeOpenTrade(overrides: Partial<PaperTrade> = {}): PaperTrade {
  return {
    id: 1,
    tokenAddress: 'TrailingStop111111111111111111111111pump',
    symbol: 'TRAIL',
    entryPriceUsd: 1,
    entrySol: 0.1,
    entryTime: 1_700_000_000,
    status: 'open',
    maxMultiplier: 10,
    remainingPercent: 20,
    signalId: 123,
    ...overrides,
  };
}

function makeTrader(trade: PaperTrade) {
  const db = {
    openTrades: vi.fn(() => [trade]),
    updateOpenTrade: vi.fn(),
    closeTrade: vi.fn(),
  };
  const notifier = { exit: vi.fn(async () => undefined) };
  const cfg = {
    maxPaperPositionSol: 0.1,
    paperSolUsdForEstimates: 90,
    paperComparisonNotionalUsd: 100,
    stopLossPercent: -40,
    takeProfitMultiples: [2, 3, 5],
    signalWindowSeconds: 300,
    paperTrailingStopActivationMultiple: 1.5,
    paperTrailingStopDrawdownPercent: 30,
  };
  return { trader: new PaperTrader(db as any, cfg as any, notifier as any), db, notifier };
}

describe('PaperTrader trailing stop exits', () => {
  beforeEach(() => {
    mockState.snapshots = [];
  });

  it('closes remaining paper inventory when peak drawdown breaches the configured trailing stop after activation', async () => {
    const trade = makeOpenTrade({ maxMultiplier: 10, remainingPercent: 20 });
    mockState.snapshots = [{ priceUsd: 6.9, liquidityUsd: 42_000 }];
    const { trader, db, notifier } = makeTrader(trade);

    await trader.updateOpenPositions();

    expect(db.updateOpenTrade).toHaveBeenCalledWith('TrailingStop111111111111111111111111pump', 10, 20, {
      priceUsd: 6.9,
      multiplier: 6.9,
      pnlPercent: 590,
      liquidityUsd: 42_000,
      checkedAt: 1_700_000_123,
    });
    expect(db.closeTrade).toHaveBeenCalledWith(
      'TrailingStop111111111111111111111111pump',
      6.9,
      1_700_000_123,
      590,
      expect.stringContaining('trailing stop 30% peak drawdown'),
    );
    expect(notifier.exit).toHaveBeenCalledWith(
      expect.objectContaining({ tokenAddress: trade.tokenAddress, maxMultiplier: 10 }),
      expect.stringContaining('trailing stop 30% peak drawdown'),
      590,
    );
  });

  it('does not trail-stop a trade before the activation multiple is reached', async () => {
    const trade = makeOpenTrade({ maxMultiplier: 1.4, remainingPercent: 100 });
    mockState.snapshots = [{ priceUsd: 0.95, liquidityUsd: 7_500 }];
    const { trader, db, notifier } = makeTrader(trade);

    await trader.updateOpenPositions();

    expect(db.closeTrade).not.toHaveBeenCalled();
    expect(notifier.exit).not.toHaveBeenCalled();
  });
});
