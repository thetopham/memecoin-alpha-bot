import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Orchestrator } from '../src/orchestrator';
import type { AppConfig } from '../src/types';

function makeConfig(dir: string): AppConfig {
  const walletsPath = path.join(dir, 'wallets.json');
  fs.writeFileSync(walletsPath, '[]');
  return {
    heliusApiKey: undefined,
    solanaRpcUrl: 'https://rpc.example.invalid',
    heliusWsUrl: undefined,
    dryRun: true,
    watchedWalletsPath: walletsPath,
    dbPath: path.join(dir, 'alpha.sqlite'),
    pollIntervalSeconds: 5,
    signatureLimit: 2,
    walletSignatureMaxPages: 3,
    rpcTimeoutMs: 1_000,
    rpcMaxRetries: 1,
    rpcMinIntervalMs: 0,
    heliusMonthlyCredits: 10_000_000,
    heliusSoftDailyCredits: 250_000,
    heliusHardDailyCredits: 300_000,
    enableApiBudgetGovernor: true,
    hotWalletLimit: 75,
    probationWalletLimit: 150,
    candidateWalletLimit: 500,
    walletCandidateAutoAddBatchLimit: 25,
    hotWalletScanIntervalSeconds: 5,
    probationWalletScanIntervalSeconds: 300,
    candidateWalletScanIntervalSeconds: 3600,
    enableWalletAutoRotation: false,
    enableWalletCandidateAutoAdd: false,
    walletRotationIntervalSeconds: 3600,
    minWalletsForSignal: 2,
    signalWindowSeconds: 300,
    minCompositeScore: 60,
    maxPaperPositionSol: 0.1,
    paperSolUsdForEstimates: 90,
    paperComparisonNotionalUsd: 100,
    stopLossPercent: -40,
    takeProfitMultiples: [2, 3, 5],
    paperTrailingStopActivationMultiple: 1.5,
    paperTrailingStopDrawdownPercent: 30,
    processHistoricalOnFirstRun: false,
    telegramBotToken: undefined,
    telegramChatId: undefined,
    enableCtScanner: false,
    cieloApiKey: undefined,
    cieloApiBaseUrl: 'https://feed-api.cielo.finance',
    cieloAppBaseUrl: 'https://app.cielo.finance',
    cieloCandidatePath: path.join(dir, 'candidates.json'),
    cieloDiscoveryReportPath: path.join(dir, 'report.json'),
    cieloMinPnlUsd: 500,
    cieloMinRoiPercent: 50,
    cieloMinWinratePercent: 45,
    cieloMaxLastActiveHours: 48,
    cieloMaxCandidates: 60,
    cieloDiscoveryPages: 2,
    cieloFeedMinUsd: 25,
    cieloFeedLookbackHours: 24,
    cieloVettingSignatureLimit: 40,
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('Orchestrator scheduler resilience', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps the service alive when the initial scan is rate-limited', async () => {
    vi.useFakeTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memecoin-alpha-orch-'));
    const orchestrator = new Orchestrator(makeConfig(dir));
    const scan = vi.spyOn(orchestrator, 'scanOnce')
      .mockRejectedValueOnce(new Error('Solana RPC HTTP 429 for getSignaturesForAddress'))
      .mockResolvedValue({ events: 0, buys: 0, sells: 0 });

    try {
      await expect(orchestrator.run()).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(scan).toHaveBeenCalledTimes(2);
    } finally {
      orchestrator.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips interval scans while a previous scan is still running', async () => {
    vi.useFakeTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memecoin-alpha-orch-'));
    const orchestrator = new Orchestrator(makeConfig(dir));
    let resolveSecondScan!: (value: { events: number; buys: number; sells: number }) => void;
    const scan = vi.spyOn(orchestrator, 'scanOnce')
      .mockResolvedValueOnce({ events: 0, buys: 0, sells: 0 })
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecondScan = resolve; }))
      .mockResolvedValue({ events: 0, buys: 0, sells: 0 });

    try {
      await orchestrator.run();
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
      expect(scan).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
      expect(scan).toHaveBeenCalledTimes(2);

      resolveSecondScan({ events: 0, buys: 0, sells: 0 });
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(scan).toHaveBeenCalledTimes(3);
    } finally {
      orchestrator.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports Developer-plan API budget and wallet tier counts in status output', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memecoin-alpha-orch-'));
    const cfg = makeConfig(dir);
    fs.writeFileSync(cfg.watchedWalletsPath, `${JSON.stringify([
      { address: '11111111111111111111111111111111', label: 'hot', tier: 'hot', enabled: true },
      { address: '22222222222222222222222222222222', label: 'candidate', tier: 'candidate', enabled: true },
    ], null, 2)}\n`);
    const orchestrator = new Orchestrator(cfg);

    try {
      const text = orchestrator.statusText();
      expect(text).toContain('wallet tiers: hot=1 probation=0 candidate=1 archive=0');
      expect(text).toContain('api budget: helius: normal');
      expect(text).toContain('10,000,000 monthly');
    } finally {
      orchestrator.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('continues scanning when opportunistic wallet maintenance fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memecoin-alpha-orch-'));
    const cfg = makeConfig(dir);
    fs.writeFileSync(cfg.watchedWalletsPath, `${JSON.stringify([
      { address: '11111111111111111111111111111111', label: 'hot', tier: 'hot', enabled: true },
    ], null, 2)}\n`);
    const orchestrator = new Orchestrator(cfg);
    const maintain = vi.spyOn(orchestrator, 'maintainWallets').mockRejectedValueOnce(new Error('wallet backup write failed'));
    const pollAll = vi.spyOn((orchestrator as any).tracker, 'pollAll').mockResolvedValueOnce([]);

    try {
      await expect(orchestrator.scanOnce(false)).resolves.toEqual({ events: 0, buys: 0, sells: 0 });
      expect(maintain).toHaveBeenCalledWith(false);
      expect(pollAll).toHaveBeenCalledTimes(1);
    } finally {
      orchestrator.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
