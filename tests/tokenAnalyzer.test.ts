import { describe, expect, it } from 'vitest';
import { scoreTokenSnapshot } from '../src/tokenAnalyzer';

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
      dexId: 'pumpfun'
    });

    expect(result.pass).toBe(false);
    expect(result.failReasons.join(' ')).toContain('liquidity');
  });
});
