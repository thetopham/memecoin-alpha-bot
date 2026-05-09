import { describe, expect, it } from 'vitest';
import { scoreTokenSnapshot } from '../src/tokenAnalyzer';
import type { TokenMarketSnapshot } from '../src/types';

function snapshot(overrides: Partial<TokenMarketSnapshot> = {}): TokenMarketSnapshot {
  return {
    symbol: 'TEST',
    liquidityUsd: 75_000,
    volume24hUsd: 250_000,
    volume1hUsd: 40_000,
    txns5mBuys: 30,
    txns5mSells: 10,
    txns1hBuys: 320,
    txns1hSells: 110,
    pairAgeMinutes: 180,
    top10HolderPercent: 35,
    priceUsd: 0.001,
    marketCap: 750_000,
    fdv: 800_000,
    dexId: 'raydium',
    liquidityStatus: 'available',
    marketStage: 'dex_pool',
    ...overrides,
  };
}

describe('scoreTokenSnapshot', () => {
  it('passes a liquid token with healthy volume and distributed holders', () => {
    const result = scoreTokenSnapshot({
      symbol: 'TEST',
      liquidityUsd: 75_000,
      volume24hUsd: 250_000,
      volume1hUsd: 40_000,
      txns5mBuys: 30,
      txns5mSells: 10,
      txns1hBuys: 320,
      txns1hSells: 110,
      pairAgeMinutes: 180,
      top10HolderPercent: 35,
      priceUsd: 0.001,
      marketCap: 750_000,
      fdv: 800_000,
      dexId: 'raydium'
    });

    expect(result.pass).toBe(true);
    expect(result.composite).toBeGreaterThanOrEqual(65);
    expect(result.failReasons).toEqual([]);
  });

  it('hard-fails tokens with dangerously concentrated top holders', () => {
    const result = scoreTokenSnapshot({
      symbol: 'RUG',
      liquidityUsd: 100_000,
      volume24hUsd: 400_000,
      volume1hUsd: 50_000,
      txns5mBuys: 50,
      txns5mSells: 5,
      txns1hBuys: 400,
      txns1hSells: 50,
      pairAgeMinutes: 60,
      top10HolderPercent: 82,
      priceUsd: 0.002,
      marketCap: 1_000_000,
      fdv: 1_000_000,
      dexId: 'pumpfun'
    });

    expect(result.pass).toBe(false);
    expect(result.failReasons.join(' ')).toContain('top 10');
  });

  it('fails illiquid tokens even if buy velocity looks good', () => {
    const result = scoreTokenSnapshot({
      symbol: 'THIN',
      liquidityUsd: 900,
      volume24hUsd: 100_000,
      volume1hUsd: 20_000,
      txns5mBuys: 50,
      txns5mSells: 1,
      txns1hBuys: 300,
      txns1hSells: 10,
      pairAgeMinutes: 45,
      top10HolderPercent: 30,
      priceUsd: 0.0001,
      marketCap: 50_000,
      fdv: 50_000,
      dexId: 'pumpfun',
      liquidityStatus: 'available',
      marketStage: 'dex_pool'
    });

    expect(result.pass).toBe(false);
    expect(result.failReasons.join(' ')).toContain('liquidity');
  });

  it('allows active pump.fun pre-graduation tokens when DEX liquidity is unavailable', () => {
    const result = scoreTokenSnapshot(snapshot({
      symbol: 'PREGRAIL',
      liquidityUsd: 0,
      liquidityStatus: 'unavailable',
      marketStage: 'pumpfun_bonding_curve',
      dexId: 'pumpfun',
      priceUsd: 0.00002399,
      volume24hUsd: 69_548.81,
      volume1hUsd: 69_548.81,
      txns5mBuys: 611,
      txns5mSells: 433,
      txns1hBuys: 611,
      txns1hSells: 433,
      pairAgeMinutes: 3.6,
      top10HolderPercent: 44.4,
    }));

    expect(result.pass).toBe(true);
    expect(result.composite).toBeGreaterThanOrEqual(65);
    expect(result.dimensions.liquidity).toBe(55);
    expect(result.failReasons.join(' ')).not.toContain('liquidity too thin at $0');
    expect(result.warnings.join(' ')).toContain('DEX liquidity unavailable / likely pre-graduation');
  });

  it('still fails non-pump tokens when DEX liquidity is unavailable', () => {
    const result = scoreTokenSnapshot(snapshot({
      symbol: 'NOPAIR',
      liquidityUsd: 0,
      liquidityStatus: 'unavailable',
      marketStage: 'unknown',
      dexId: 'unknown',
      priceUsd: 0.00002399,
      volume24hUsd: 69_548.81,
      volume1hUsd: 69_548.81,
      txns5mBuys: 611,
      txns5mSells: 433,
      txns1hBuys: 611,
      txns1hSells: 433,
      pairAgeMinutes: 3.6,
      top10HolderPercent: 44.4,
    }));

    expect(result.pass).toBe(false);
    expect(result.failReasons.join(' ')).toContain('DEX liquidity unavailable / no usable pool');
    expect(result.failReasons.join(' ')).not.toContain('liquidity too thin at $0');
  });

  it('warns instead of hard-failing high holder concentration on active pump.fun pre-graduation tokens', () => {
    const result = scoreTokenSnapshot(snapshot({
      symbol: 'EARLY',
      liquidityUsd: 0,
      liquidityStatus: 'unavailable',
      marketStage: 'pumpfun_bonding_curve',
      dexId: 'pumpfun',
      priceUsd: 0.000006,
      volume24hUsd: 120_000,
      volume1hUsd: 55_000,
      txns5mBuys: 95,
      txns5mSells: 55,
      txns1hBuys: 900,
      txns1hSells: 500,
      pairAgeMinutes: 8,
      top10HolderPercent: 83.5,
    }));

    expect(result.pass).toBe(true);
    expect(result.failReasons.join(' ')).not.toContain('top 10 holders concentrated');
    expect(result.warnings.join(' ')).toContain('pre-graduation holder concentration high');
  });

  it('still hard-fails extreme holder concentration on pump.fun pre-graduation tokens', () => {
    const result = scoreTokenSnapshot(snapshot({
      symbol: 'SNIPED',
      liquidityUsd: 0,
      liquidityStatus: 'unavailable',
      marketStage: 'pumpfun_bonding_curve',
      dexId: 'pumpfun',
      priceUsd: 0.000006,
      volume24hUsd: 120_000,
      volume1hUsd: 55_000,
      txns5mBuys: 95,
      txns5mSells: 55,
      txns1hBuys: 900,
      txns1hSells: 500,
      pairAgeMinutes: 8,
      top10HolderPercent: 96,
    }));

    expect(result.pass).toBe(false);
    expect(result.failReasons.join(' ')).toContain('top 10 holders extremely concentrated');
  });
});
