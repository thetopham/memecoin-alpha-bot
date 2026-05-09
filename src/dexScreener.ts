import type { LiquidityStatus, MarketStage, TokenMarketSnapshot } from './types';
import { toNumber } from './utils';

function liquidityStatus(rawLiquidityUsd: unknown, liquidityUsd: number): LiquidityStatus {
  if (liquidityUsd > 0) return 'available';
  return rawLiquidityUsd == null || rawLiquidityUsd === '' ? 'unavailable' : 'zero';
}

function looksLikePumpFunPair(pair: any, tokenAddress: string): boolean {
  const dexId = String(pair?.dexId ?? '').toLowerCase();
  const url = String(pair?.url ?? '').toLowerCase();
  const pairAddress = String(pair?.pairAddress ?? '').toLowerCase();
  const mint = tokenAddress.toLowerCase();
  return dexId.includes('pump') || url.includes('pump.fun') || url.includes('pump') || pairAddress.endsWith('pump') || mint.endsWith('pump');
}

function inferMarketStage(pair: any, tokenAddress: string, liquidityUsd: number): MarketStage {
  if (liquidityUsd > 0) return 'dex_pool';
  if (looksLikePumpFunPair(pair, tokenAddress)) return 'pumpfun_bonding_curve';
  return 'unknown';
}

function pairSortValue(pair: any): number {
  const liquidity = toNumber(pair?.liquidity?.usd, 0);
  const volume = toNumber(pair?.volume?.h24, 0);
  const txns = toNumber(pair?.txns?.m5?.buys, 0) + toNumber(pair?.txns?.m5?.sells, 0);
  return liquidity * 1_000_000 + volume * 1_000 + txns;
}

function firstPositive(...values: unknown[]): number {
  for (const value of values) {
    const parsed = toNumber(value, 0);
    if (parsed > 0) return parsed;
  }
  return 0;
}

function normalizedSupply(coin: any, metadata: any): number {
  const rawSupply = firstPositive(coin?.total_supply, coin?.total_supply_str, metadata?.total_supply, metadata?.coinCreatedSupply);
  if (rawSupply <= 0) return 1_000_000_000;
  const decimals = Math.max(0, Math.min(18, toNumber(coin?.base_decimals, 6)));
  return rawSupply / Math.pow(10, decimals);
}

function ageMinutesFromTimestamp(timestamp: unknown): number | null {
  const created = toNumber(timestamp, 0);
  if (created <= 0) return null;
  const createdMs = created > 10_000_000_000 ? created : created * 1000;
  return Math.max(0, (Date.now() - createdMs) / 60000);
}

function estimateWindowValue(total: number, ageMinutes: number | null, windowMinutes: number): number {
  if (total <= 0) return 0;
  if (ageMinutes == null || ageMinutes <= 0 || ageMinutes <= windowMinutes) return total;
  return total * Math.min(1, windowMinutes / ageMinutes);
}

function estimateWindowTransactions(total: unknown, ageMinutes: number | null, windowMinutes: number): number {
  return Math.round(estimateWindowValue(toNumber(total, 0), ageMinutes, windowMinutes));
}

async function fetchJsonOrNull(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: {
        accept: 'application/json, text/plain, */*',
        origin: 'https://pump.fun',
        referer: 'https://pump.fun/',
        'user-agent': 'memecoin-alpha-bot/0.1',
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function getPumpFunSnapshot(tokenAddress: string, top10HolderPercent: number | null): Promise<TokenMarketSnapshot | null> {
  const mint = encodeURIComponent(tokenAddress);
  const coin = await fetchJsonOrNull(`https://frontend-api-v3.pump.fun/coins/${mint}?sync=true`);
  const metadata = await fetchJsonOrNull(`https://advanced-api-v2.pump.fun/coins/metadata/${mint}`);
  if (!coin && !metadata) return null;

  const supply = normalizedSupply(coin, metadata);
  const marketCap = firstPositive(metadata?.marketcap, metadata?.market_cap, coin?.usd_market_cap, coin?.market_cap);
  const priceUsd = firstPositive(metadata?.current_market_price) || (marketCap > 0 && supply > 0 ? marketCap / supply : 0);
  const createdTimestamp = coin?.created_timestamp ?? metadata?.creation_time;
  const pairAgeMinutes = ageMinutesFromTimestamp(createdTimestamp);
  const nativeVolumeUsd = firstPositive(metadata?.volume_usd, metadata?.volume);
  const buyTransactions = firstPositive(metadata?.buy_transactions);
  const sellTransactions = firstPositive(metadata?.sell_transactions);
  const topTenOwned = firstPositive(metadata?.topTenHoldersOwnedAmount);
  const derivedTop10 = topTenOwned > 0 && supply > 0 ? Math.min(100, (topTenOwned / supply) * 100) : null;
  const graduationDate = firstPositive(metadata?.graduation_date);
  const complete = Boolean(coin?.complete) || graduationDate > 0;

  return {
    tokenAddress,
    symbol: String(metadata?.ticker ?? coin?.symbol ?? 'UNKNOWN'),
    name: typeof metadata?.name === 'string' ? metadata.name : typeof coin?.name === 'string' ? coin.name : undefined,
    dexId: 'pumpfun',
    url: `https://pump.fun/coin/${tokenAddress}`,
    marketDataSource: 'pumpfun',
    priceUsd,
    liquidityUsd: 0,
    liquidityStatus: 'unavailable',
    marketStage: complete ? 'unknown' : 'pumpfun_bonding_curve',
    volume24hUsd: nativeVolumeUsd,
    volume1hUsd: estimateWindowValue(nativeVolumeUsd, pairAgeMinutes, 60),
    txns5mBuys: estimateWindowTransactions(buyTransactions, pairAgeMinutes, 5),
    txns5mSells: estimateWindowTransactions(sellTransactions, pairAgeMinutes, 5),
    txns1hBuys: estimateWindowTransactions(buyTransactions, pairAgeMinutes, 60),
    txns1hSells: estimateWindowTransactions(sellTransactions, pairAgeMinutes, 60),
    pairAgeMinutes,
    top10HolderPercent: top10HolderPercent ?? derivedTop10,
    marketCap: marketCap || null,
    fdv: marketCap || null,
    holderCount: firstPositive(metadata?.num_holders_v2, metadata?.num_holders) || null,
    bondingCurveProgressPercent: firstPositive(metadata?.progress) || null,
    nativeVolumeUsd: nativeVolumeUsd || null,
  };
}

export class DexScreenerClient {
  async getBestSnapshot(tokenAddress: string, top10HolderPercent: number | null = null): Promise<TokenMarketSnapshot | null> {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(tokenAddress)}`;
    let data: any;
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);
      data = await res.json() as any;
    } catch (err) {
      const fallback = await getPumpFunSnapshot(tokenAddress, top10HolderPercent);
      if (fallback) return fallback;
      throw err;
    }

    const pairs = Array.isArray(data?.pairs) ? data.pairs.filter((p: any) => p?.chainId === 'solana') : [];
    if (pairs.length === 0) return getPumpFunSnapshot(tokenAddress, top10HolderPercent);

    pairs.sort((a: any, b: any) => pairSortValue(b) - pairSortValue(a));
    const pair = pairs[0];
    const createdAt = toNumber(pair?.pairCreatedAt, 0);
    const pairAgeMinutes = createdAt > 0 ? Math.max(0, (Date.now() - createdAt) / 60000) : null;
    const base = pair?.baseToken ?? {};
    const rawLiquidityUsd = pair?.liquidity?.usd;
    const liquidityUsd = toNumber(rawLiquidityUsd, 0);

    return {
      tokenAddress,
      symbol: String(base.symbol ?? 'UNKNOWN'),
      name: typeof base.name === 'string' ? base.name : undefined,
      pairAddress: typeof pair.pairAddress === 'string' ? pair.pairAddress : undefined,
      dexId: typeof pair.dexId === 'string' ? pair.dexId : undefined,
      url: typeof pair.url === 'string' ? pair.url : undefined,
      marketDataSource: 'dexscreener',
      priceUsd: toNumber(pair.priceUsd, 0),
      liquidityUsd,
      liquidityStatus: liquidityStatus(rawLiquidityUsd, liquidityUsd),
      marketStage: inferMarketStage(pair, tokenAddress, liquidityUsd),
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
