import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const ENV_KEYS = [
  'MIN_COMPOSITE_SCORE',
  'POLL_INTERVAL_SECONDS',
  'PAPER_SOL_USD_FOR_ESTIMATES',
  'PAPER_COMPARISON_NOTIONAL_USD',
  'HELIUS_API_KEY',
  'SOLANA_RPC_URL',
  'HELIUS_WS_URL',
  'HELIUS_MONTHLY_CREDITS',
  'HELIUS_SOFT_DAILY_CREDITS',
  'HELIUS_HARD_DAILY_CREDITS',
  'ENABLE_API_BUDGET_GOVERNOR',
  'HOT_WALLET_LIMIT',
  'PROBATION_WALLET_LIMIT',
  'CANDIDATE_WALLET_LIMIT',
  'WALLET_CANDIDATE_AUTO_ADD_BATCH_LIMIT',
  'HOT_WALLET_SCAN_INTERVAL_SECONDS',
  'PROBATION_WALLET_SCAN_INTERVAL_SECONDS',
  'CANDIDATE_WALLET_SCAN_INTERVAL_SECONDS',
  'ENABLE_WALLET_AUTO_ROTATION',
  'ENABLE_WALLET_CANDIDATE_AUTO_ADD',
  'WALLET_ROTATION_INTERVAL_SECONDS',
  'PAPER_TRAILING_STOP_ACTIVATION_MULTIPLE',
  'PAPER_TRAILING_STOP_DRAWDOWN_PERCENT',
] as const;

describe('loadConfig', () => {
  const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map(key => [key, process.env[key]]));

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const original = originalEnv.get(key);
      if (original == null) delete process.env[key];
      else process.env[key] = original;
    }
  });

  it('defaults the composite score threshold to 60 for early pump.fun discovery', () => {
    delete process.env.MIN_COMPOSITE_SCORE;

    expect(loadConfig().minCompositeScore).toBe(60);
  });

  it('defaults to Developer-plan polling/budget and paper execution sizing assumptions', () => {
    delete process.env.POLL_INTERVAL_SECONDS;
    delete process.env.PAPER_SOL_USD_FOR_ESTIMATES;
    delete process.env.PAPER_COMPARISON_NOTIONAL_USD;
    delete process.env.HELIUS_MONTHLY_CREDITS;

    const cfg = loadConfig();

    expect(cfg.pollIntervalSeconds).toBe(30);
    expect(cfg.heliusMonthlyCredits).toBe(10_000_000);
    expect(cfg.heliusSoftDailyCredits).toBe(250_000);
    expect(cfg.heliusHardDailyCredits).toBe(300_000);
    expect(cfg.enableApiBudgetGovernor).toBe(true);
    expect(cfg.hotWalletLimit).toBe(75);
    expect(cfg.walletCandidateAutoAddBatchLimit).toBe(25);
    expect(cfg.paperSolUsdForEstimates).toBe(90);
    expect(cfg.paperComparisonNotionalUsd).toBe(100);
    expect(cfg.paperTrailingStopActivationMultiple).toBe(1.5);
    expect(cfg.paperTrailingStopDrawdownPercent).toBe(30);
  });

  it('allows paper trailing-stop activation and drawdown to be tuned via env', () => {
    process.env.PAPER_TRAILING_STOP_ACTIVATION_MULTIPLE = '2';
    process.env.PAPER_TRAILING_STOP_DRAWDOWN_PERCENT = '25';

    const cfg = loadConfig();

    expect(cfg.paperTrailingStopActivationMultiple).toBe(2);
    expect(cfg.paperTrailingStopDrawdownPercent).toBe(25);
  });

  it('defaults Helius RPC to the beta endpoint when only a Helius API key is set', () => {
    process.env.HELIUS_API_KEY = 'test-helius-key';
    delete process.env.SOLANA_RPC_URL;
    delete process.env.HELIUS_WS_URL;

    expect(loadConfig().solanaRpcUrl).toBe('https://beta.helius-rpc.com/?api-key=test-helius-key');
  });
});
