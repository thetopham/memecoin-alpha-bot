import type { TokenMarketSnapshot, TokenScore } from './types';
import { clamp } from './utils';
import { DexScreenerClient } from './dexScreener';
import { SolanaRpcClient } from './rpc';
import { getTop10HolderPercent } from './holderAnalysis';

function isLikelyPumpFun(snapshot: TokenMarketSnapshot): boolean {
  const dexId = snapshot.dexId?.toLowerCase() ?? '';
  const url = snapshot.url?.toLowerCase() ?? '';
  const tokenAddress = snapshot.tokenAddress?.toLowerCase() ?? '';
  return snapshot.marketStage === 'pumpfun_bonding_curve' || dexId.includes('pump') || url.includes('pump.fun') || tokenAddress.endsWith('pump');
}

function isPumpFunPreGraduation(snapshot: TokenMarketSnapshot): boolean {
  return snapshot.marketStage === 'pumpfun_bonding_curve' || (snapshot.liquidityUsd <= 0 && isLikelyPumpFun(snapshot));
}

function isPreGraduationLiquidityUnavailable(snapshot: TokenMarketSnapshot): boolean {
  return snapshot.liquidityUsd <= 0 && isPumpFunPreGraduation(snapshot);
}

function scoreLiquidity(snapshot: TokenMarketSnapshot): number {
  const usd = snapshot.liquidityUsd;
  if (isPreGraduationLiquidityUnavailable(snapshot)) return 55;
  if (usd <= 0) return 0;
  if (usd < 1_000) return 10;
  if (usd < 5_000) return 30;
  if (usd < 20_000) return 55;
  if (usd < 100_000) return 80;
  return 95;
}

function assessLiquidity(snapshot: TokenMarketSnapshot): { warning?: string; hardFail?: string } {
  if (isPreGraduationLiquidityUnavailable(snapshot)) {
    return { warning: 'DEX liquidity unavailable / likely pre-graduation' };
  }
  if (snapshot.liquidityUsd <= 0) {
    return { hardFail: 'DEX liquidity unavailable / no usable pool' };
  }
  if (snapshot.liquidityUsd < 1_000) {
    return { hardFail: `liquidity too thin at $${snapshot.liquidityUsd.toFixed(0)}` };
  }
  if (snapshot.liquidityUsd < 5_000) {
    return { warning: `liquidity thin at $${snapshot.liquidityUsd.toFixed(0)}` };
  }
  return {};
}

function scoreVolume(h24: number, h1: number): number {
  const h24Score = h24 < 10_000 ? 20 : h24 < 50_000 ? 45 : h24 < 250_000 ? 75 : 95;
  const h1Score = h1 < 2_000 ? 20 : h1 < 10_000 ? 50 : h1 < 50_000 ? 80 : 95;
  return Math.round(h24Score * 0.65 + h1Score * 0.35);
}

function scoreDistribution(snapshot: TokenMarketSnapshot): { score: number; warning?: string; hardFail?: string } {
  const top10 = snapshot.top10HolderPercent;
  if (top10 == null) return { score: 55, warning: 'top holder concentration unavailable' };

  if (isPumpFunPreGraduation(snapshot)) {
    if (top10 > 95) return { score: 0, hardFail: `top 10 holders extremely concentrated at ${top10.toFixed(1)}%` };
    if (top10 > 90) return { score: 10, warning: `pre-graduation holder concentration extreme at ${top10.toFixed(1)}%` };
    if (top10 > 70) return { score: 25, warning: `pre-graduation holder concentration high at ${top10.toFixed(1)}%` };
    if (top10 > 60) return { score: 35, warning: `pre-graduation holder concentration elevated at ${top10.toFixed(1)}%` };
    if (top10 > 45) return { score: 55, warning: `top 10 holders elevated at ${top10.toFixed(1)}%` };
    if (top10 > 30) return { score: 78 };
    return { score: 95 };
  }

  if (top10 > 70) return { score: 0, hardFail: `top 10 holders concentrated at ${top10.toFixed(1)}%` };
  if (top10 > 60) return { score: 30, warning: `top 10 holders high at ${top10.toFixed(1)}%` };
  if (top10 > 45) return { score: 55, warning: `top 10 holders elevated at ${top10.toFixed(1)}%` };
  if (top10 > 30) return { score: 78 };
  return { score: 95 };
}

function scoreVelocity(buys5m: number, sells5m: number, buys1h: number, sells1h: number): number {
  const m5Total = buys5m + sells5m;
  const h1Total = buys1h + sells1h;
  const m5BuyRatio = m5Total > 0 ? buys5m / m5Total : 0.5;
  const h1BuyRatio = h1Total > 0 ? buys1h / h1Total : 0.5;
  const activity = Math.min(1, (m5Total / 30) * 0.6 + (h1Total / 250) * 0.4);
  const ratioScore = clamp((m5BuyRatio * 0.7 + h1BuyRatio * 0.3) * 100, 0, 100);
  return Math.round(ratioScore * 0.65 + activity * 100 * 0.35);
}

function scoreAge(minutes: number | null): number {
  if (minutes == null) return 50;
  if (minutes < 3) return 25;
  if (minutes < 15) return 60;
  if (minutes < 360) return 90;
  if (minutes < 1440) return 75;
  if (minutes < 10080) return 55;
  return 35;
}

export function scoreTokenSnapshot(snapshot: TokenMarketSnapshot): TokenScore {
  const failReasons: string[] = [];
  const warnings: string[] = [];

  const liquidity = scoreLiquidity(snapshot);
  const volume = scoreVolume(snapshot.volume24hUsd, snapshot.volume1hUsd);
  const distributionInfo = scoreDistribution(snapshot);
  const liquidityInfo = assessLiquidity(snapshot);
  const velocity = scoreVelocity(snapshot.txns5mBuys, snapshot.txns5mSells, snapshot.txns1hBuys, snapshot.txns1hSells);
  const age = scoreAge(snapshot.pairAgeMinutes);

  if (distributionInfo.warning) warnings.push(distributionInfo.warning);
  if (distributionInfo.hardFail) failReasons.push(distributionInfo.hardFail);
  if (liquidityInfo.warning) warnings.push(liquidityInfo.warning);
  if (liquidityInfo.hardFail) failReasons.push(liquidityInfo.hardFail);
  if (snapshot.volume24hUsd < 5_000 && snapshot.volume1hUsd < 1_000) failReasons.push('volume too low to trust signal');
  if (snapshot.txns5mSells > Math.max(10, snapshot.txns5mBuys * 2.5)) failReasons.push('sell pressure dominates 5m flow');

  const composite = Math.round(
    volume * 0.25 +
    liquidity * 0.20 +
    distributionInfo.score * 0.30 +
    velocity * 0.15 +
    age * 0.10
  );

  return {
    symbol: snapshot.symbol,
    composite,
    pass: failReasons.length === 0,
    failReasons,
    warnings,
    dimensions: {
      volume,
      liquidity,
      distribution: distributionInfo.score,
      velocity,
      age,
    },
    snapshot,
  };
}

export class TokenAnalyzer {
  private readonly dex = new DexScreenerClient();

  constructor(private readonly rpc: SolanaRpcClient) {}

  async score(tokenAddress: string): Promise<TokenScore | null> {
    const top10HolderPercent = await getTop10HolderPercent(this.rpc, tokenAddress);
    const snapshot = await this.dex.getBestSnapshot(tokenAddress, top10HolderPercent);
    if (!snapshot) return null;
    return scoreTokenSnapshot(snapshot);
  }
}
