import { describe, expect, it } from 'vitest';
import { renderDashboardPage } from '../src/dashboard';
import type { PaperTrade } from '../src/types';

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
    expect(html).not.toContain('<section>\n      <h2>Open Positions</h2>\n      <pre>Open paper trades:');
  });
});
