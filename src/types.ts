export type WalletPerformanceRecommendation = 'promote' | 'keep' | 'probation' | 'demote' | 'disable_candidate';

export interface WalletSignalAttributionRow {
  signalId: number;
  tokenAddress: string;
  symbol: string;
  pass: boolean;
  compositeScore: number;
  walletsJson: string;
  createdAt: number;
  tradeId?: number | null;
  tradeStatus?: 'open' | 'closed' | null;
  entrySol?: number | null;
  remainingPercent?: number | null;
  pnlPercent?: number | null;
  lastPnlPercent?: number | null;
  estimatedSlippageBps?: number | null;
  latestWalletToFillSeconds?: number | null;
  signalToFillSeconds?: number | null;
  exitTime?: number | null;
}

export interface WalletPerformance {
  address: string;
  label: string;
  currentTrust: number | null;
  suggestedTrust: number | null;
  signals: number;
  passedSignals: number;
  passRatePercent: number | null;
  paperTrades: number;
  closedTrades: number;
  openTrades: number;
  openExposureSol: number;
  winRatePercent: number | null;
  avgPnlPercent: number | null;
  medianPnlPercent: number | null;
  avgSlippageBps: number | null;
  avgLatestWalletToFillSeconds: number | null;
  avgSignalToFillSeconds: number | null;
  badSignalStreak: number;
  recommendation: WalletPerformanceRecommendation;
  alphaScore: number;
  reason: string;
  sampleSymbols: string[];
}

export type SwapDirection = 'buy' | 'sell';
export type SwapSource = 'pumpfun' | 'raydium' | 'jupiter' | 'orca' | 'unknown';

export interface WalletConfig {
  address: string;
  label?: string;
  trust?: number;
  enabled?: boolean;
}

export interface WalletSwapEvent {
  wallet: string;
  tokenAddress: string;
  tokenSymbol?: string;
  direction: SwapDirection;
  solAmount: number;
  txHash: string;
  timestamp: number; // unix seconds
  source: SwapSource;
}

export interface ConvergenceWallet {
  wallet: string;
  label?: string;
  trust: number;
  solAmount: number;
  txHash: string;
  timestamp: number;
  source: SwapSource;
}

export interface ConvergenceSignal {
  tokenAddress: string;
  wallets: ConvergenceWallet[];
  walletCount: number;
  weightedTrust: number;
  windowSeconds: number;
  firstSeen: number;
  lastSeen: number;
  sources: SwapSource[];
}

export type LiquidityStatus = 'available' | 'unavailable' | 'zero';
export type MarketStage = 'dex_pool' | 'pumpfun_bonding_curve' | 'unknown';
export type MarketDataSource = 'dexscreener' | 'pumpfun';

export interface TokenMarketSnapshot {
  tokenAddress?: string;
  symbol: string;
  name?: string;
  pairAddress?: string;
  dexId?: string;
  url?: string;
  marketDataSource?: MarketDataSource;
  priceUsd: number;
  liquidityUsd: number;
  liquidityStatus?: LiquidityStatus;
  marketStage?: MarketStage;
  volume24hUsd: number;
  volume1hUsd: number;
  txns5mBuys: number;
  txns5mSells: number;
  txns1hBuys: number;
  txns1hSells: number;
  pairAgeMinutes: number | null;
  top10HolderPercent: number | null;
  marketCap?: number | null;
  fdv?: number | null;
  holderCount?: number | null;
  bondingCurveProgressPercent?: number | null;
  nativeVolumeUsd?: number | null;
}

export interface TokenScore {
  symbol: string;
  composite: number;
  pass: boolean;
  failReasons: string[];
  warnings: string[];
  dimensions: {
    volume: number;
    liquidity: number;
    distribution: number;
    velocity: number;
    age: number;
  };
  snapshot: TokenMarketSnapshot;
}

export interface AppConfig {
  heliusApiKey?: string;
  solanaRpcUrl: string;
  heliusWsUrl?: string;
  dryRun: boolean;
  watchedWalletsPath: string;
  dbPath: string;
  pollIntervalSeconds: number;
  signatureLimit: number;
  minWalletsForSignal: number;
  signalWindowSeconds: number;
  minCompositeScore: number;
  maxPaperPositionSol: number;
  paperSolUsdForEstimates: number;
  paperComparisonNotionalUsd: number;
  stopLossPercent: number;
  takeProfitMultiples: number[];
  processHistoricalOnFirstRun: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;
  enableCtScanner: boolean;
  cieloApiKey?: string;
  cieloApiBaseUrl: string;
  cieloAppBaseUrl: string;
  cieloCandidatePath: string;
  cieloDiscoveryReportPath: string;
  cieloMinPnlUsd: number;
  cieloMinRoiPercent: number;
  cieloMinWinratePercent: number;
  cieloMaxLastActiveHours: number;
  cieloMaxCandidates: number;
  cieloDiscoveryPages: number;
  cieloFeedMinUsd: number;
  cieloFeedLookbackHours: number;
  cieloVettingSignatureLimit: number;
}

export type PaperLiquidityConfidence = 'high' | 'low' | 'unknown';

export interface PaperExecutionEstimate {
  observedPriceUsd: number;
  estimatedFillPriceUsd: number;
  estimatedSlippageBps: number;
  estimatedPriceImpactBps: number;
  notionalUsd: number;
  entrySol: number;
  referenceSolUsd: number;
  comparisonNotionalUsd: number;
  comparisonSlippageBps: number;
  comparisonFillPriceUsd: number;
  effectiveLiquidityUsd: number | null;
  liquidityBasis: string;
  liquidityConfidence: PaperLiquidityConfidence;
  fillModel: string;
  fillSource: MarketDataSource | 'unknown';
  signalFirstSeenAt?: number | null;
  signalLastSeenAt?: number | null;
  signalCreatedAt?: number | null;
  firstWalletToFillSeconds?: number | null;
  latestWalletToFillSeconds?: number | null;
  signalToFillSeconds?: number | null;
}

export interface PaperTrade {
  id: number;
  tokenAddress: string;
  symbol: string;
  entryPriceUsd: number;
  entrySol: number;
  entryTime: number;
  status: 'open' | 'closed';
  maxMultiplier: number;
  remainingPercent: number;
  signalId?: number | null;
  observedPriceUsd?: number | null;
  estimatedFillPriceUsd?: number | null;
  estimatedSlippageBps?: number | null;
  estimatedPriceImpactBps?: number | null;
  estimatedNotionalUsd?: number | null;
  referenceSolUsd?: number | null;
  comparisonNotionalUsd?: number | null;
  comparisonSlippageBps?: number | null;
  comparisonFillPriceUsd?: number | null;
  effectiveLiquidityUsd?: number | null;
  liquidityBasis?: string | null;
  liquidityConfidence?: PaperLiquidityConfidence | null;
  fillModel?: string | null;
  fillSource?: MarketDataSource | 'unknown' | null;
  signalFirstSeenAt?: number | null;
  signalLastSeenAt?: number | null;
  signalCreatedAt?: number | null;
  firstWalletToFillSeconds?: number | null;
  latestWalletToFillSeconds?: number | null;
  signalToFillSeconds?: number | null;
  lastPriceUsd?: number | null;
  lastMultiplier?: number | null;
  lastPnlPercent?: number | null;
  lastLiquidityUsd?: number | null;
  lastCheckedAt?: number | null;
  exitPriceUsd?: number | null;
  exitTime?: number | null;
  pnlPercent?: number | null;
  exitReason?: string | null;
}
