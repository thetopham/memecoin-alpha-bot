import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { AlphaDb } from '../src/db';

describe('AlphaDb paper execution fields', () => {
  it('persists paper fill/slippage/timing metadata with a paper trade', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memecoin-alpha-db-'));
    const db = new AlphaDb(path.join(dir, 'alpha.sqlite'));

    try {
      const id = db.openPaperTrade('Token111111111111111111111111111111111111111', 'EXEC', 0.00001001797, 0.1, 44, 1_700_000_020, {
        observedPriceUsd: 0.00001,
        estimatedFillPriceUsd: 0.00001001797,
        estimatedSlippageBps: 17.97,
        estimatedPriceImpactBps: 17.97,
        notionalUsd: 9,
        entrySol: 0.1,
        referenceSolUsd: 90,
        comparisonNotionalUsd: 100,
        comparisonSlippageBps: 196.08,
        comparisonFillPriceUsd: 0.00001019608,
        effectiveLiquidityUsd: 10_000,
        liquidityBasis: 'DEX pool liquidity',
        liquidityConfidence: 'high',
        fillModel: 'dex_constant_product_v1',
        fillSource: 'dexscreener',
        signalFirstSeenAt: 1_700_000_000,
        signalLastSeenAt: 1_700_000_015,
        signalCreatedAt: 1_700_000_020,
        firstWalletToFillSeconds: 20,
        latestWalletToFillSeconds: 5,
        signalToFillSeconds: 0,
      });

      const [trade] = db.openTrades();

      expect(trade.id).toBe(id);
      expect(trade.estimatedFillPriceUsd).toBeCloseTo(0.00001001797, 10);
      expect(trade.estimatedSlippageBps).toBeCloseTo(17.97, 2);
      expect(trade.estimatedNotionalUsd).toBe(9);
      expect(trade.comparisonNotionalUsd).toBe(100);
      expect(trade.comparisonSlippageBps).toBeCloseTo(196.08, 2);
      expect(trade.latestWalletToFillSeconds).toBe(5);
      expect(trade.fillModel).toBe('dex_constant_product_v1');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
