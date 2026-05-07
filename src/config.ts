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
    ? `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`
    : 'https://api.mainnet-beta.solana.com';
  const defaultWs = heliusApiKey
    ? `wss://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`
    : undefined;

  const cfg: AppConfig = {
    heliusApiKey,
    solanaRpcUrl: optional('SOLANA_RPC_URL') ?? defaultRpc,
    heliusWsUrl: optional('HELIUS_WS_URL') ?? defaultWs,
    dryRun: bool('DRY_RUN', true),
    watchedWalletsPath: path.resolve(process.cwd(), optional('WATCHED_WALLETS_PATH') ?? './config/watched-wallets.json'),
    dbPath: path.resolve(process.cwd(), optional('DB_PATH') ?? './data/memecoin-alpha.sqlite'),
    pollIntervalSeconds: Math.max(5, num('POLL_INTERVAL_SECONDS', 30)),
    signatureLimit: Math.max(1, Math.min(50, num('SIGNATURE_LIMIT', 12))),
    minWalletsForSignal: Math.max(2, num('MIN_WALLETS_FOR_SIGNAL', 2)),
    signalWindowSeconds: Math.max(30, num('SIGNAL_WINDOW_SECONDS', 300)),
    minCompositeScore: Math.max(0, Math.min(100, num('MIN_COMPOSITE_SCORE', 65))),
    maxPaperPositionSol: Math.max(0, num('MAX_PAPER_POSITION_SOL', 0.1)),
    stopLossPercent: Math.min(0, num('STOP_LOSS_PERCENT', -40)),
    takeProfitMultiples: [
      num('TAKE_PROFIT_1_MULTIPLE', 2),
      num('TAKE_PROFIT_2_MULTIPLE', 3),
      num('TAKE_PROFIT_3_MULTIPLE', 5),
    ].filter(v => v > 1),
    processHistoricalOnFirstRun: bool('PROCESS_HISTORICAL_ON_FIRST_RUN', false),
    telegramBotToken: optional('TELEGRAM_BOT_TOKEN'),
    telegramChatId: optional('TELEGRAM_CHAT_ID'),
    enableCtScanner: bool('ENABLE_CT_SCANNER', false),
  };

  if (!cfg.dryRun) {
    throw new Error('Live trading is intentionally disabled in v1. Set DRY_RUN=true.');
  }

  return cfg;
}
