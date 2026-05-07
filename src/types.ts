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

export interface TokenMarketSnapshot {
  symbol: string;
  name?: string;
  pairAddress?: string;
  dexId?: string;
  url?: string;
  priceUsd: number;
  liquidityUsd: number;
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
  stopLossPercent: number;
  takeProfitMultiples: number[];
  processHistoricalOnFirstRun: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;
  enableCtScanner: boolean;
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
  exitPriceUsd?: number | null;
  exitTime?: number | null;
  pnlPercent?: number | null;
  exitReason?: string | null;
}
