import type { PaperExecutionEstimate, PaperLiquidityConfidence, TokenMarketSnapshot } from './types';
import { clamp } from './utils';

export interface PaperExecutionEstimateOptions {
  entrySol: number;
  referenceSolUsd: number;
  comparisonNotionalUsd: number;
  fillAt: number;
  signalFirstSeenAt?: number | null;
  signalLastSeenAt?: number | null;
  signalCreatedAt?: number | null;
}

interface LiquidityBasis {
  effectiveLiquidityUsd: number | null;
  liquidityBasis: string;
  liquidityConfidence: PaperLiquidityConfidence;
  fillModel: string;
}

export function estimatePaperExecution(
  snapshot: TokenMarketSnapshot,
  options: PaperExecutionEstimateOptions,
): PaperExecutionEstimate {
  const observedPriceUsd = Math.max(0, finite(snapshot.priceUsd));
  const referenceSolUsd = Math.max(0, finite(options.referenceSolUsd));
  const entrySol = Math.max(0, finite(options.entrySol));
  const notionalUsd = entrySol * referenceSolUsd;
  const comparisonNotionalUsd = Math.max(0, finite(options.comparisonNotionalUsd));
  const liquidity = resolveLiquidityBasis(snapshot);
  const estimatedSlippageBps = estimateSlippageBps(notionalUsd, liquidity.effectiveLiquidityUsd);
  const comparisonSlippageBps = estimateSlippageBps(comparisonNotionalUsd, liquidity.effectiveLiquidityUsd);
  const estimatedFillPriceUsd = applyBuySlippage(observedPriceUsd, estimatedSlippageBps);
  const comparisonFillPriceUsd = applyBuySlippage(observedPriceUsd, comparisonSlippageBps);
  const signalCreatedAt = options.signalCreatedAt ?? null;
  const signalFirstSeenAt = options.signalFirstSeenAt ?? null;
  const signalLastSeenAt = options.signalLastSeenAt ?? null;

  return {
    observedPriceUsd,
    estimatedFillPriceUsd,
    estimatedSlippageBps,
    estimatedPriceImpactBps: estimatedSlippageBps,
    notionalUsd,
    entrySol,
    referenceSolUsd,
    comparisonNotionalUsd,
    comparisonSlippageBps,
    comparisonFillPriceUsd,
    effectiveLiquidityUsd: liquidity.effectiveLiquidityUsd,
    liquidityBasis: liquidity.liquidityBasis,
    liquidityConfidence: liquidity.liquidityConfidence,
    fillModel: liquidity.fillModel,
    fillSource: snapshot.marketDataSource ?? 'unknown',
    signalFirstSeenAt,
    signalLastSeenAt,
    signalCreatedAt,
    firstWalletToFillSeconds: secondsBetween(signalFirstSeenAt, options.fillAt),
    latestWalletToFillSeconds: secondsBetween(signalLastSeenAt, options.fillAt),
    signalToFillSeconds: secondsBetween(signalCreatedAt, options.fillAt),
  };
}

function resolveLiquidityBasis(snapshot: TokenMarketSnapshot): LiquidityBasis {
  if (snapshot.liquidityUsd > 0) {
    return {
      effectiveLiquidityUsd: snapshot.liquidityUsd,
      liquidityBasis: 'DEX pool liquidity',
      liquidityConfidence: 'high',
      fillModel: 'dex_constant_product_v1',
    };
  }

  if (snapshot.marketStage === 'pumpfun_bonding_curve' || snapshot.marketDataSource === 'pumpfun') {
    const anchor = firstPositive(snapshot.marketCap, snapshot.fdv, snapshot.nativeVolumeUsd);
    const effectiveLiquidityUsd = anchor > 0
      ? clamp(anchor * 0.05, 250, 25_000)
      : 500;
    return {
      effectiveLiquidityUsd,
      liquidityBasis: anchor > 0 ? 'pump.fun market-cap proxy' : 'pump.fun fallback proxy',
      liquidityConfidence: 'low',
      fillModel: 'pumpfun_curve_proxy_v1',
    };
  }

  return {
    effectiveLiquidityUsd: null,
    liquidityBasis: 'unavailable',
    liquidityConfidence: 'unknown',
    fillModel: 'unavailable_v1',
  };
}

function estimateSlippageBps(notionalUsd: number, effectiveLiquidityUsd: number | null): number {
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) return 0;
  if (effectiveLiquidityUsd == null || !Number.isFinite(effectiveLiquidityUsd) || effectiveLiquidityUsd <= 0) return 0;
  const inputReserveUsd = effectiveLiquidityUsd / 2;
  return (notionalUsd / (inputReserveUsd + notionalUsd)) * 10_000;
}

function applyBuySlippage(priceUsd: number, slippageBps: number): number {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return 0;
  return priceUsd * (1 + Math.max(0, slippageBps) / 10_000);
}

function secondsBetween(start: number | null, end: number): number | null {
  if (start == null || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor(end - start));
}

function firstPositive(...values: Array<number | null | undefined>): number {
  for (const value of values) {
    const parsed = finite(value);
    if (parsed > 0) return parsed;
  }
  return 0;
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
