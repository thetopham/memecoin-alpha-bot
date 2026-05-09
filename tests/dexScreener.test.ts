import { afterEach, describe, expect, it, vi } from 'vitest';
import { DexScreenerClient } from '../src/dexScreener';

describe('DexScreenerClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('marks pump.fun snapshots with missing DEX liquidity as pre-graduation bonding-curve markets', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        pairs: [
          {
            chainId: 'solana',
            dexId: 'pumpfun',
            url: 'https://dexscreener.com/solana/PREGRAD',
            pairAddress: 'PREGRADPAIR',
            baseToken: { symbol: 'PREGRAIL', name: 'Pre Grad Rail' },
            priceUsd: '0.00002399',
            volume: { h24: 69_548.81, h1: 69_548.81 },
            txns: { m5: { buys: 611, sells: 433 }, h1: { buys: 611, sells: 433 } },
            pairCreatedAt: Date.now() - 4 * 60_000,
            marketCap: 23_990,
            fdv: 23_990,
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await new DexScreenerClient().getBestSnapshot('abc123pump', 44.4);

    expect(snapshot).toMatchObject({
      symbol: 'PREGRAIL',
      liquidityUsd: 0,
      liquidityStatus: 'unavailable',
      marketStage: 'pumpfun_bonding_curve',
      dexId: 'pumpfun',
      priceUsd: 0.00002399,
      top10HolderPercent: 44.4,
    });
  });

  it('does not reuse a cached snapshot with stale holder-concentration context', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        pairs: [
          {
            chainId: 'solana',
            dexId: 'raydium',
            pairAddress: 'PAIRCTX',
            baseToken: { symbol: 'CTX', name: 'Cache Context' },
            priceUsd: '0.00001',
            liquidity: { usd: 10_000 },
            volume: { h24: 50_000, h1: 4_000 },
            txns: { m5: { buys: 4, sells: 2 }, h1: { buys: 40, sells: 20 } },
            pairCreatedAt: Date.now() - 60 * 60_000,
            marketCap: 10_000,
            fdv: 10_000,
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new DexScreenerClient();

    const unknownHolderSnapshot = await client.getBestSnapshot('cacheContextMint', null);
    const concentratedHolderSnapshot = await client.getBestSnapshot('cacheContextMint', 72.5);

    expect(unknownHolderSnapshot?.top10HolderPercent).toBeNull();
    expect(concentratedHolderSnapshot?.top10HolderPercent).toBe(72.5);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to pump.fun native metadata when DexScreener has not indexed a pair yet', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ pairs: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          mint: 'maybe123pump',
          symbol: 'MAYBE',
          name: 'Buy Now, Pay Maybe',
          complete: false,
          created_timestamp: Date.now() - 8 * 60_000,
          usd_market_cap: 5_000,
          market_cap: 55,
          total_supply: 1_000_000_000_000_000,
          base_decimals: 6,
          virtual_sol_reserves: 45_000_000_000,
          real_sol_reserves: 15_000_000_000,
          last_trade_timestamp: Date.now() - 30_000,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          mint: 'maybe123pump',
          ticker: 'MAYBE',
          name: 'Buy Now, Pay Maybe',
          volume_usd: '119803.77',
          buy_transactions: '1018',
          sell_transactions: '987',
          transactions: '2005',
          marketcap: '5961.75',
          topTenHoldersOwnedAmount: '287742129.24657303',
          progress: '47.63',
          num_holders_v2: '47',
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await new DexScreenerClient().getBestSnapshot('maybe123pump', null);

    expect(snapshot).toMatchObject({
      tokenAddress: 'maybe123pump',
      symbol: 'MAYBE',
      name: 'Buy Now, Pay Maybe',
      dexId: 'pumpfun',
      liquidityUsd: 0,
      liquidityStatus: 'unavailable',
      marketStage: 'pumpfun_bonding_curve',
      volume24hUsd: 119_803.77,
      txns1hBuys: 1018,
      txns1hSells: 987,
      marketCap: 5961.75,
    });
    expect(snapshot?.priceUsd).toBeCloseTo(0.00000596175, 12);
    expect(snapshot?.top10HolderPercent).toBeCloseTo(28.774, 2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
