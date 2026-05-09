import path from 'path';
import dotenv from 'dotenv';
import type { AppConfig } from './types';

dotenv.config();

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function num(name: string, fallback: number): number {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function loadConfig(): AppConfig {
  const heliusApiKey = optional('HELIUS_API_KEY');
  const defaultRpc = heliusApiKey
    ? `https://beta.helius-rpc.com/?api-key=${heliusApiKey}`
    : 'https://api.mainnet-beta.solana.com';
  const defaultWs = heliusApiKey
    ? `wss://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`
    : undefined;

  const pollIntervalSeconds = Math.max(5, num('POLL_INTERVAL_SECONDS', 30));
  const cfg: AppConfig = {
    heliusApiKey,
    solanaRpcUrl: optional('SOLANA_RPC_URL') ?? defaultRpc,
    heliusWsUrl: optional('HELIUS_WS_URL') ?? defaultWs,
    dryRun: bool('DRY_RUN', true),
    watchedWalletsPath: path.resolve(process.cwd(), optional('WATCHED_WALLETS_PATH') ?? './config/watched-wallets.json'),
    dbPath: path.resolve(process.cwd(), optional('DB_PATH') ?? './data/memecoin-alpha.sqlite'),
    pollIntervalSeconds,
    signatureLimit: Math.max(1, Math.min(50, num('SIGNATURE_LIMIT', 12))),
    walletSignatureMaxPages: Math.max(1, Math.min(25, num('WALLET_SIGNATURE_MAX_PAGES', 6))),
    rpcTimeoutMs: Math.max(1_000, Math.min(60_000, num('RPC_TIMEOUT_MS', 15_000))),
    rpcMaxRetries: Math.max(0, Math.min(10, num('RPC_MAX_RETRIES', 5))),
    rpcMinIntervalMs: Math.max(0, Math.min(5_000, num('RPC_MIN_INTERVAL_MS', 125))),
    heliusMonthlyCredits: Math.max(1, num('HELIUS_MONTHLY_CREDITS', 10_000_000)),
    heliusSoftDailyCredits: Math.max(1, num('HELIUS_SOFT_DAILY_CREDITS', 250_000)),
    heliusHardDailyCredits: Math.max(1, num('HELIUS_HARD_DAILY_CREDITS', 300_000)),
    enableApiBudgetGovernor: bool('ENABLE_API_BUDGET_GOVERNOR', true),
    hotWalletLimit: Math.max(1, Math.min(500, num('HOT_WALLET_LIMIT', 75))),
    probationWalletLimit: Math.max(0, Math.min(2_000, num('PROBATION_WALLET_LIMIT', 150))),
    candidateWalletLimit: Math.max(0, Math.min(5_000, num('CANDIDATE_WALLET_LIMIT', 500))),
    walletCandidateAutoAddBatchLimit: Math.max(0, Math.min(250, num('WALLET_CANDIDATE_AUTO_ADD_BATCH_LIMIT', 25))),
    hotWalletScanIntervalSeconds: Math.max(5, num('HOT_WALLET_SCAN_INTERVAL_SECONDS', pollIntervalSeconds)),
    probationWalletScanIntervalSeconds: Math.max(30, num('PROBATION_WALLET_SCAN_INTERVAL_SECONDS', 600)),
    candidateWalletScanIntervalSeconds: Math.max(60, num('CANDIDATE_WALLET_SCAN_INTERVAL_SECONDS', 3_600)),
    enableWalletAutoRotation: bool('ENABLE_WALLET_AUTO_ROTATION', true),
    enableWalletCandidateAutoAdd: bool('ENABLE_WALLET_CANDIDATE_AUTO_ADD', true),
    walletRotationIntervalSeconds: Math.max(300, num('WALLET_ROTATION_INTERVAL_SECONDS', 3_600)),
    minWalletsForSignal: Math.max(2, num('MIN_WALLETS_FOR_SIGNAL', 2)),
    signalWindowSeconds: Math.max(30, num('SIGNAL_WINDOW_SECONDS', 300)),
    minCompositeScore: Math.max(0, Math.min(100, num('MIN_COMPOSITE_SCORE', 60))),
    maxPaperPositionSol: Math.max(0, num('MAX_PAPER_POSITION_SOL', 0.1)),
    paperSolUsdForEstimates: Math.max(0, num('PAPER_SOL_USD_FOR_ESTIMATES', 90)),
    paperComparisonNotionalUsd: Math.max(0, num('PAPER_COMPARISON_NOTIONAL_USD', 100)),
    stopLossPercent: Math.min(0, num('STOP_LOSS_PERCENT', -40)),
    takeProfitMultiples: [
      num('TAKE_PROFIT_1_MULTIPLE', 2),
      num('TAKE_PROFIT_2_MULTIPLE', 3),
      num('TAKE_PROFIT_3_MULTIPLE', 5),
    ].filter(v => v > 1),
    paperTrailingStopActivationMultiple: Math.max(1, num('PAPER_TRAILING_STOP_ACTIVATION_MULTIPLE', 1.5)),
    paperTrailingStopDrawdownPercent: Math.max(0, Math.min(95, num('PAPER_TRAILING_STOP_DRAWDOWN_PERCENT', 30))),
    processHistoricalOnFirstRun: bool('PROCESS_HISTORICAL_ON_FIRST_RUN', false),
    dashboardAuthToken: optional('DASHBOARD_AUTH_TOKEN'),
    telegramBotToken: optional('TELEGRAM_BOT_TOKEN'),
    telegramChatId: optional('TELEGRAM_CHAT_ID'),
    enableCtScanner: bool('ENABLE_CT_SCANNER', false),
    cieloApiKey: optional('CIELO_API_KEY'),
    cieloApiBaseUrl: optional('CIELO_API_BASE_URL') ?? 'https://feed-api.cielo.finance',
    cieloAppBaseUrl: optional('CIELO_APP_BASE_URL') ?? 'https://app.cielo.finance',
    cieloCandidatePath: path.resolve(process.cwd(), optional('CIELO_CANDIDATE_PATH') ?? './config/cielo-wallet-candidates.json'),
    cieloDiscoveryReportPath: path.resolve(process.cwd(), optional('CIELO_DISCOVERY_REPORT_PATH') ?? './data/cielo-wallet-discovery-report.json'),
    cieloMinPnlUsd: Math.max(0, num('CIELO_MIN_PNL_USD', 500)),
    cieloMinRoiPercent: Math.max(0, num('CIELO_MIN_ROI_PERCENT', 50)),
    cieloMinWinratePercent: Math.max(0, Math.min(100, num('CIELO_MIN_WINRATE_PERCENT', 45))),
    cieloMaxLastActiveHours: Math.max(1, num('CIELO_MAX_LAST_ACTIVE_HOURS', 48)),
    cieloMaxCandidates: Math.max(1, Math.min(500, num('CIELO_MAX_CANDIDATES', 60))),
    cieloDiscoveryPages: Math.max(1, Math.min(10, num('CIELO_DISCOVERY_PAGES', 2))),
    cieloFeedMinUsd: Math.max(0, num('CIELO_FEED_MIN_USD', 25)),
    cieloFeedLookbackHours: Math.max(1, num('CIELO_FEED_LOOKBACK_HOURS', 24)),
    cieloVettingSignatureLimit: Math.max(1, Math.min(100, num('CIELO_VETTING_SIGNATURE_LIMIT', 40))),
  };

  if (!cfg.dryRun) {
    throw new Error('Live trading is intentionally disabled in v1. Set DRY_RUN=true.');
  }

  return cfg;
}
