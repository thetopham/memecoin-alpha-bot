import type { TokenMarketSnapshot } from './types';
import { toNumber } from './utils';

export class DexScreenerClient {
  async getBestSnapshot(tokenAddress: string, top10HolderPercent: number | null = null): Promise<TokenMarketSnapshot | null> {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(tokenAddress)}`;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);
    const data = await res.json() as any;
    const pairs = Array.isArray(data?.pairs) ? data.pairs.filter((p: any) => p?.chainId === 'solana') : [];
    if (pairs.length === 0) return null;

    pairs.sort((a: any, b: any) => toNumber(b?.liquidity?.usd, 0) - toNumber(a?.liquidity?.usd, 0));
    const pair = pairs[0];
    const createdAt = toNumber(pair?.pairCreatedAt, 0);
    const pairAgeMinutes = createdAt > 0 ? Math.max(0, (Date.now() - createdAt) / 60000) : null;
    const base = pair?.baseToken ?? {};

    return {
      symbol: String(base.symbol ?? 'UNKNOWN'),
      name: typeof base.name === 'string' ? base.name : undefined,
      pairAddress: typeof pair.pairAddress === 'string' ? pair.pairAddress : undefined,
      dexId: typeof pair.dexId === 'string' ? pair.dexId : undefined,
      url: typeof pair.url === 'string' ? pair.url : undefined,
      priceUsd: toNumber(pair.priceUsd, 0),
      liquidityUsd: toNumber(pair?.liquidity?.usd, 0),
      volume24hUsd: toNumber(pair?.volume?.h24, 0),
      volume1hUsd: toNumber(pair?.volume?.h1, 0),
      txns5mBuys: toNumber(pair?.txns?.m5?.buys, 0),
      txns5mSells: toNumber(pair?.txns?.m5?.sells, 0),
      txns1hBuys: toNumber(pair?.txns?.h1?.buys, 0),
      txns1hSells: toNumber(pair?.txns?.h1?.sells, 0),
      pairAgeMinutes,
      top10HolderPercent,
      marketCap: pair.marketCap == null ? null : toNumber(pair.marketCap, 0),
      fdv: pair.fdv == null ? null : toNumber(pair.fdv, 0),
    };
  }
}
