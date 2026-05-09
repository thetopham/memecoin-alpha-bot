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

  it('defaults to faster 10s polling and paper execution sizing assumptions', () => {
    delete process.env.POLL_INTERVAL_SECONDS;
    delete process.env.PAPER_SOL_USD_FOR_ESTIMATES;
    delete process.env.PAPER_COMPARISON_NOTIONAL_USD;

    const cfg = loadConfig();

    expect(cfg.pollIntervalSeconds).toBe(10);
    expect(cfg.paperSolUsdForEstimates).toBe(90);
    expect(cfg.paperComparisonNotionalUsd).toBe(100);
  });

  it('defaults Helius RPC to the beta endpoint when only a Helius API key is set', () => {
    process.env.HELIUS_API_KEY = 'test-helius-key';
    delete process.env.SOLANA_RPC_URL;
    delete process.env.HELIUS_WS_URL;

    expect(loadConfig().solanaRpcUrl).toBe('https://beta.helius-rpc.com/?api-key=test-helius-key');
  });
});
