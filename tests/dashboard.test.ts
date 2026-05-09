import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDashboardViewModel, renderDashboardPage, startDashboardServer } from '../src/dashboard';
import { AlphaDb } from '../src/db';
import type { AppConfig, PaperTrade } from '../src/types';

function makeDashboardConfig(dir: string): AppConfig {
  const walletsPath = path.join(dir, 'wallets.json');
  fs.writeFileSync(walletsPath, '[]');
  return {
    heliusApiKey: undefined,
    solanaRpcUrl: 'https://rpc.example.invalid',
    heliusWsUrl: undefined,
    dryRun: true,
    watchedWalletsPath: walletsPath,
    dbPath: path.join(dir, 'alpha.sqlite'),
    pollIntervalSeconds: 10,
    signatureLimit: 2,
    walletSignatureMaxPages: 1,
    rpcTimeoutMs: 1_000,
    rpcMaxRetries: 1,
    rpcMinIntervalMs: 0,
    heliusMonthlyCredits: 1_000_000,
    heliusSoftDailyCredits: 25_000,
    heliusHardDailyCredits: 30_000,
    enableApiBudgetGovernor: true,
    hotWalletLimit: 75,
    probationWalletLimit: 150,
    candidateWalletLimit: 500,
    walletCandidateAutoAddBatchLimit: 25,
    hotWalletScanIntervalSeconds: 10,
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function closeServer(server: { close(cb: () => void): void }): Promise<void> {
  await new Promise<void>(resolve => server.close(resolve));
}

const sampleOpenTrade: PaperTrade = {
  id: 37,
  tokenAddress: '9VxDWa11111111111111111111111111111Q7bg',
  symbol: 'KOMUGI',
  status: 'open',
  entryPriceUsd: 0.0000288054,
  entrySol: 0.1,
  entryTime: 1_699_999_000,
  remainingPercent: 100,
  maxMultiplier: 1.82,
  minMultiplier: 0.7,
  takeProfitsHit: 0,
  signalId: 339,
  observedPriceUsd: 0.00002845,
  estimatedFillPriceUsd: 0.0000288054,
  estimatedSlippageBps: 124.9,
  estimatedNotionalUsd: 9,
  comparisonNotionalUsd: 100,
  comparisonSlippageBps: 1232.4,
  latestWalletToFillSeconds: 9,
  firstWalletToFillSeconds: 27,
  signalToFillSeconds: 0,
  fillModel: 'pumpfun_curve_proxy_v1',
  fillSource: 'dexscreener',
  liquidityConfidence: 'low',
  liquidityBasis: 'pump.fun market-cap proxy',
  lastPriceUsd: 0.00002809,
  lastMultiplier: 0.98,
  lastPnlPercent: -2.5,
  lastLiquidityUsd: 13_700,
  lastCheckedAt: 1_699_999_970,
};

describe('buildDashboardViewModel', () => {
  it('reads bot-persisted data without fetching external APIs or incrementing API usage', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memecoin-alpha-dashboard-'));
    const cfg = makeDashboardConfig(dir);
    const db = new AlphaDb(cfg.dbPath);
    const fetchSpy = vi.fn(() => Promise.reject(new Error('dashboard must not fetch external APIs')));
    vi.stubGlobal('fetch', fetchSpy);

    try {
      db.recordApiUsage({ provider: 'helius', endpoint: 'preexisting-bot-call', credits: 1, createdAt: 1 });
      db.openPaperTrade(
        'LocalBotToken11111111111111111111111111111111',
        'LOCAL',
        0.0001,
        0.1,
        42,
        1_700_000_000,
      );
      const beforeUsage = db.apiUsageByProviderSince(0);

      const model = buildDashboardViewModel(cfg, db, { refreshSeconds: 15 });
      const html = renderDashboardPage(model);
      const afterUsage = db.apiUsageByProviderSince(0);

      expect(model.openTrades).toBe(1);
      expect(model.openPositions[0]?.symbol).toBe('LOCAL');
      expect(model.opsCrons.map(job => job.jobId)).toEqual(['2b59421d3551', 'f7822adb2503', 'bd525bf8d155']);
      expect(model.dataSourceNote).toContain('does not call Helius');
      expect(model.paperExitRulesText).toContain('trailing 30.0% from peak after 1.50x');
      expect(html).toContain('$LOCAL');
      expect(html).toContain('trailing 30.0% from peak after 1.50x');
      expect(html).toContain('Hermes Ops Automation');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(afterUsage).toEqual(beforeUsage);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('startDashboardServer auth', () => {
  it('accepts the dashboard token in a header, not in the URL query string', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memecoin-alpha-dashboard-'));
    const cfg = makeDashboardConfig(dir);
    const authToken = ['test', 'dashboard', 'token'].join('-');
    const server = await startDashboardServer(cfg, {
      host: '127.0.0.1',
      port: 0,
      refreshSeconds: 5,
      authToken,
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const queryTokenResponse = await fetch(`http://127.0.0.1:${port}/api/dashboard?token=${authToken}`);
      expect(queryTokenResponse.status).toBe(401);

      const headerTokenResponse = await fetch(`http://127.0.0.1:${port}/api/dashboard`, {
        headers: { 'x-dashboard-token': authToken },
      });
      expect(headerTokenResponse.status).toBe(200);
    } finally {
      await closeServer(server);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('renderDashboardPage', () => {
  it('renders a paper-trade dashboard with open, closed, PnL, and signal sections', () => {
    const html = renderDashboardPage({
      generatedAt: 1_700_000_000,
      dryRun: true,
      wallets: 17,
      signals: 182,
      openTrades: 1,
      closedTrades: 2,
      pendingMarketRetries: 0,
      avgPnlPercent: 15.1,
      winRate: 50,
      portfolioText: 'Paper PnL summary:\nrealized closed PnL: +0.030 SOL (+15.1% avg, 50.0% win rate)\nunrealized open PnL: +0.005 SOL (+5.2% on remaining inventory)\nestimated total PnL: +0.035 SOL',
      openPositions: [sampleOpenTrade],
      closedPositions: [
        {
          ...sampleOpenTrade,
          id: 2,
          symbol: 'MRNA',
          status: 'closed',
          exitPriceUsd: 0.00002362,
          exitTime: 1_699_999_600,
          exitReason: 'stop_loss',
          pnlPercent: -18,
          remainingPercent: 0,
        },
      ],
      openPositionsText: 'Open paper trades:\n#37 $KOMUGI — PAPER OPEN\n  current: $0.0000280900 = 0.98x (-2.5%)',
      closedPositionsText: 'Recent closed paper trades:\n#2 $MRNA — PAPER CLOSED\n  realized: -18.0% (-0.018 SOL est)',
      walletPerformance: [
        {
          address: 'walletA11111111111111111111111111111111111',
          label: 'alpha_a',
          currentTrust: 0.55,
          suggestedTrust: 0.6,
          signals: 7,
          passedSignals: 5,
          passRatePercent: 71.4,
          paperTrades: 5,
          closedTrades: 4,
          openTrades: 1,
          openExposureSol: 0.08,
          winRatePercent: 75,
          avgPnlPercent: 24.2,
          medianPnlPercent: 18.5,
          avgSlippageBps: 14.8,
          avgLatestWalletToFillSeconds: 8,
          avgSignalToFillSeconds: 0,
          badSignalStreak: 0,
          recommendation: 'promote',
          alphaScore: 88,
          reason: 'profitable paper attribution',
          sampleSymbols: ['MOM'],
        },
      ],
      walletPerformanceText: 'Wallet Alpha Scoreboard:\n#1 alpha_a wallet...1111 — promote | alpha 88/100',
      recentSignals: [
        '#182 $FOO score=68/100 pass=true wallets=2 Foo111...pump',
        '  warnings: DEX liquidity unavailable / likely pre-graduation',
      ],
      paperExitRulesText: 'stop -40.0%; trailing 30.0% from peak after 1.50x; take-profits 2x→80%, 3x→50%, 5x→20%',
      opsCrons: [
        {
          name: 'Bot Health Watchdog',
          jobId: '2b59421d3551',
          schedule: 'every 10m',
          script: '~/.hermes/scripts/memecoin_bot_health_watchdog.py',
          purpose: 'service/auth/API-budget/log watchdog',
          behavior: 'silent-on-ok',
          tone: 'positive',
        },
        {
          name: 'Position Manager',
          jobId: 'f7822adb2503',
          schedule: 'every 20m',
          script: '~/.hermes/scripts/memecoin_position_manager.py',
          purpose: 'paper position stale checks',
          behavior: 'cooldown alerts',
          tone: 'warning',
        },
        {
          name: 'Wallet Scanner / Maintainer',
          jobId: 'bd525bf8d155',
          schedule: '17 */6 * * *',
          script: '~/.hermes/scripts/memecoin_wallet_scanner.py',
          purpose: 'wallet candidate and rotation maintenance',
          behavior: 'bounded candidate adds with backups',
          tone: 'purple',
        },
      ],
      dataSourceNote: 'API-neutral: dashboard reads local SQLite/watchlist state only; does not call Helius or Solana RPC.',
      refreshSeconds: 15,
    });

    expect(html).toContain('<title>Memecoin Alpha Dashboard</title>');
    expect(html).toContain('PAPER / DRY RUN');
    expect(html).toContain('Open Trades');
    expect(html).toContain('$KOMUGI');
    expect(html).toContain('Closed Trades');
    expect(html).toContain('$MRNA');
    expect(html).toContain('Realized PnL');
    expect(html).toContain('Recent Signals');
    expect(html).toContain('Hermes Ops Automation');
    expect(html).toContain('Bot Health Watchdog');
    expect(html).toContain('Position Manager');
    expect(html).toContain('Wallet Scanner / Maintainer');
    expect(html).toContain('does not call Helius');
    expect(html).toContain('Wallet Alpha Scoreboard');
    expect(html).toContain('alpha_a wallet...1111');
    expect(html).toContain('refreshes every 15s');
    expect(html).toContain('class="dashboard-shell"');
    expect(html).toContain('class="hero-card"');
    expect(html).toContain('class="portfolio-strip"');
    expect(html).toContain('class="trade-card open"');
    expect(html).toContain('class="wallet-card promote"');
    expect(html).toContain('Open details');
    expect(html).toContain('Details');
    expect(html).toContain('Slippage');
    expect(html).toContain('$100 check');
    expect(html).toContain('Latest wallet→fill');
    expect(html).toContain('trailing 30.0% from peak after 1.50x');
    expect(html).not.toContain('<section>\n      <h2>Open Positions</h2>\n      <pre>Open paper trades:');
  });
});
