import { describe, expect, it } from 'vitest';
import { estimatePaperExecution } from '../src/fillSimulator';
import type { TokenMarketSnapshot } from '../src/types';

const dexSnapshot: TokenMarketSnapshot = {
  tokenAddress: 'Token111111111111111111111111111111111111111',
  symbol: 'TEST',
  marketDataSource: 'dexscreener',
  priceUsd: 0.00001,
  liquidityUsd: 10_000,
  liquidityStatus: 'available',
  marketStage: 'dex_pool',
  volume24hUsd: 0,
  volume1hUsd: 0,
  txns5mBuys: 0,
  txns5mSells: 0,
  txns1hBuys: 0,
  txns1hSells: 0,
  pairAgeMinutes: null,
  top10HolderPercent: null,
};

describe('estimatePaperExecution', () => {
  it('models actual paper size and a $100 size check from pool liquidity', () => {
    const estimate = estimatePaperExecution(dexSnapshot, {
      entrySol: 0.1,
      referenceSolUsd: 90,
      comparisonNotionalUsd: 100,
      signalFirstSeenAt: 1_000,
      signalLastSeenAt: 1_015,
      signalCreatedAt: 1_020,
      fillAt: 1_020,
    });

    expect(estimate.observedPriceUsd).toBe(0.00001);
    expect(estimate.notionalUsd).toBe(9);
    expect(estimate.estimatedSlippageBps).toBeCloseTo(17.97, 2);
    expect(estimate.estimatedFillPriceUsd).toBeCloseTo(0.00001001797, 10);
    expect(estimate.comparisonNotionalUsd).toBe(100);
    expect(estimate.comparisonSlippageBps).toBeCloseTo(196.08, 2);
    expect(estimate.fillModel).toBe('dex_constant_product_v1');
    expect(estimate.fillSource).toBe('dexscreener');
    expect(estimate.firstWalletToFillSeconds).toBe(20);
    expect(estimate.latestWalletToFillSeconds).toBe(5);
    expect(estimate.signalToFillSeconds).toBe(0);
  });

  it('uses a clearly labeled low-confidence proxy for pump.fun pre-graduation tokens without DEX liquidity', () => {
    const estimate = estimatePaperExecution({
      ...dexSnapshot,
      marketDataSource: 'pumpfun',
      liquidityUsd: 0,
      liquidityStatus: 'unavailable',
      marketStage: 'pumpfun_bonding_curve',
      marketCap: 20_000,
    }, {
      entrySol: 0.1,
      referenceSolUsd: 90,
      comparisonNotionalUsd: 100,
      fillAt: 2_000,
    });

    expect(estimate.fillSource).toBe('pumpfun');
    expect(estimate.fillModel).toBe('pumpfun_curve_proxy_v1');
    expect(estimate.liquidityBasis).toBe('pump.fun market-cap proxy');
    expect(estimate.liquidityConfidence).toBe('low');
    expect(estimate.effectiveLiquidityUsd).toBeGreaterThan(0);
    expect(estimate.comparisonSlippageBps).toBeGreaterThan(estimate.estimatedSlippageBps);
  });
});
