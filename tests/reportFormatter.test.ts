import { describe, expect, it } from 'vitest';
import { formatClosedPositions, formatOpenPositions, formatPaperPortfolioSummary, formatWalletPerformance, normalizeSignalReasonText } from '../src/reportFormatter';
import type { PaperTrade, WalletPerformance } from '../src/types';

describe('formatOpenPositions', () => {
  it('prints actionable paper-position details instead of only max and remaining percent', () => {
    const trade: PaperTrade = {
      id: 1,
      tokenAddress: 'BANKJmnopqrstuvwxyzmeta',
      symbol: 'AVICI',
      entryPriceUsd: 0.00000123,
      entrySol: 0.1,
      entryTime: 1_700_000_000,
      status: 'open',
      maxMultiplier: 2.25,
      remainingPercent: 80,
      signalId: 11,
      lastPriceUsd: 0.000001845,
      lastMultiplier: 1.5,
      lastPnlPercent: 50,
      lastLiquidityUsd: 42_000,
      lastCheckedAt: 1_700_000_120,
    };

    const text = formatOpenPositions([trade], {
      now: 1_700_000_180,
      stopLossPercent: -40,
      takeProfitMultiples: [2, 3, 5],
    });

    expect(text).toContain('#1 $AVICI — PAPER OPEN');
    expect(text).toContain('size: 0.100 SOL simulated | remaining: 80.0%');
    expect(text).toContain('entry: $0.0000012300 (opened 3m ago via signal #11)');
    expect(text).toContain('current: $0.0000018450 = 1.50x (+50.0%) | liq: $42.0K');
    expect(text).toContain('peak: 2.25x | drawdown from peak: -33.3%');
    expect(text).toContain('exits: stop -40.0%; take-profits 2x→80%, 3x→50%, 5x→20%');
    expect(text).toContain('token: BANKJm...meta');
    expect(text).toContain('last check: 1m ago');
  });

  it('shows paper execution realism with fill estimate, $100 size check, and wallet-to-fill timing', () => {
    const trade: PaperTrade = {
      id: 4,
      tokenAddress: 'ExecRealism111111111111111111111111pump',
      symbol: 'EXEC',
      entryPriceUsd: 0.00001001797,
      entrySol: 0.1,
      entryTime: 1_700_000_020,
      status: 'open',
      maxMultiplier: 1,
      remainingPercent: 100,
      signalId: 44,
      observedPriceUsd: 0.00001,
      estimatedFillPriceUsd: 0.00001001797,
      estimatedSlippageBps: 17.97,
      estimatedNotionalUsd: 9,
      comparisonNotionalUsd: 100,
      comparisonSlippageBps: 196.08,
      fillModel: 'dex_constant_product_v1',
      fillSource: 'dexscreener',
      signalFirstSeenAt: 1_700_000_000,
      signalLastSeenAt: 1_700_000_015,
      signalCreatedAt: 1_700_000_020,
      firstWalletToFillSeconds: 20,
      latestWalletToFillSeconds: 5,
      signalToFillSeconds: 0,
    };

    const text = formatOpenPositions([trade], {
      now: 1_700_000_080,
      stopLossPercent: -40,
      takeProfitMultiples: [2, 3, 5],
    });

    expect(text).toContain('execution: observed $0.0000100000 → est fill $0.0000100180 (+18.0 bps) | size ≈ $9');
    expect(text).toContain('$100 size check: est slippage +196.1 bps');
    expect(text).toContain('latency: latest wallet→fill 5s | first wallet→fill 20s | signal→fill 0s');
    expect(text).toContain('model: dex_constant_product_v1 via dexscreener');
  });

  it('clearly labels open positions that do not have a current price yet', () => {
    const trade: PaperTrade = {
      id: 2,
      tokenAddress: 'DoJdue111111pump',
      symbol: 'NEW',
      entryPriceUsd: 0.00000456,
      entrySol: 0.1,
      entryTime: 1_700_000_000,
      status: 'open',
      maxMultiplier: 1,
      remainingPercent: 100,
      signalId: 12,
    };

    const text = formatOpenPositions([trade], {
      now: 1_700_003_600,
      stopLossPercent: -40,
      takeProfitMultiples: [2, 3, 5],
    });

    expect(text).toContain('#2 $NEW — PAPER OPEN');
    expect(text).toContain('current: n/a (no DexScreener price captured yet)');
    expect(text).toContain('last check: never');
  });

  it('does not show positive drawdown when the current multiplier is at the peak', () => {
    const trade: PaperTrade = {
      id: 3,
      tokenAddress: 'BANKJmnopqrstuvwxyzmeta',
      symbol: 'PEAK',
      entryPriceUsd: 1,
      entrySol: 0.1,
      entryTime: 1_700_000_000,
      status: 'open',
      maxMultiplier: 1.06,
      remainingPercent: 100,
      lastPriceUsd: 1.06,
      lastMultiplier: 1.06,
      lastPnlPercent: 6,
      lastCheckedAt: 1_700_000_120,
    };

    const text = formatOpenPositions([trade], {
      now: 1_700_000_180,
      stopLossPercent: -40,
      takeProfitMultiples: [2, 3, 5],
    });

    expect(text).toContain('peak: 1.06x | drawdown from peak: 0.0%');
    expect(text).not.toContain('drawdown from peak: +0.0%');
  });

  it('prints the configured trailing stop alongside hard stop and take-profit exits', () => {
    const trade: PaperTrade = {
      id: 5,
      tokenAddress: 'TrailDisplay1111111111111111111111pump',
      symbol: 'TRAIL',
      entryPriceUsd: 1,
      entrySol: 0.1,
      entryTime: 1_700_000_000,
      status: 'open',
      maxMultiplier: 7.35,
      remainingPercent: 20,
      lastPriceUsd: 5,
      lastMultiplier: 5,
      lastPnlPercent: 400,
      lastCheckedAt: 1_700_000_120,
    };

    const text = formatOpenPositions([trade], {
      now: 1_700_000_180,
      stopLossPercent: -40,
      takeProfitMultiples: [2, 3, 5],
      paperTrailingStopActivationMultiple: 1.5,
      paperTrailingStopDrawdownPercent: 30,
    });

    expect(text).toContain('exits: stop -40.0%; trailing 30.0% from peak after 1.50x; take-profits 2x→80%, 3x→50%, 5x→20%');
  });
});

describe('formatPaperPortfolioSummary', () => {
  it('shows realized, unrealized, total paper PnL and win rate in SOL terms', () => {
    const open: PaperTrade = {
      id: 1,
      tokenAddress: 'BANKJmnopqrstuvwxyzmeta',
      symbol: 'AVICI',
      entryPriceUsd: 1,
      entrySol: 0.1,
      entryTime: 1_700_000_000,
      status: 'open',
      maxMultiplier: 1.06,
      remainingPercent: 100,
      lastPriceUsd: 1.06,
      lastMultiplier: 1.06,
      lastPnlPercent: 6,
      lastCheckedAt: 1_700_000_120,
    };
    const winnersAndLosers: PaperTrade[] = [
      {
        id: 3,
        tokenAddress: 'MomCoin111111111111pump',
        symbol: 'MOM',
        entryPriceUsd: 0.0000097913,
        entrySol: 0.1,
        entryTime: 1_700_000_000,
        status: 'closed',
        maxMultiplier: 1.48,
        remainingPercent: 0,
        exitPriceUsd: 0.0000145200,
        exitTime: 1_700_000_029,
        pnlPercent: 48.3,
        exitReason: '2+ tracked wallets sold inside exit window',
        signalId: 181,
      },
      {
        id: 2,
        tokenAddress: 'MRNAToken11111111111pump',
        symbol: 'MRNA',
        entryPriceUsd: 0.00002003,
        entrySol: 0.1,
        entryTime: 1_700_000_000,
        status: 'closed',
        maxMultiplier: 1.17,
        remainingPercent: 0,
        exitPriceUsd: 0.00001642,
        exitTime: 1_700_000_300,
        pnlPercent: -18.0,
        exitReason: '2+ tracked wallets sold inside exit window',
        signalId: 176,
      },
    ];

    const text = formatPaperPortfolioSummary([open], winnersAndLosers, {
      now: 1_700_000_360,
      stopLossPercent: -40,
      takeProfitMultiples: [2, 3, 5],
    });

    expect(text).toContain('Paper PnL summary:');
    expect(text).toContain('realized closed PnL: +0.030 SOL (+15.2% avg, 50.0% win rate)');
    expect(text).toContain('unrealized open PnL: +0.006 SOL (+6.0% on remaining inventory)');
    expect(text).toContain('estimated total PnL: +0.036 SOL');
  });
});

describe('formatClosedPositions', () => {
  it('prints recent closed trade entry, exit, realized PnL, hold time, reason, and signal id', () => {
    const closed: PaperTrade = {
      id: 3,
      tokenAddress: 'MomCoin111111111111pump',
      symbol: 'MOM',
      entryPriceUsd: 0.0000097913,
      entrySol: 0.1,
      entryTime: 1_700_000_000,
      status: 'closed',
      maxMultiplier: 1.48,
      remainingPercent: 0,
      exitPriceUsd: 0.0000145200,
      exitTime: 1_700_000_029,
      pnlPercent: 48.3,
      exitReason: '2+ tracked wallets sold inside exit window',
      signalId: 181,
    };

    const text = formatClosedPositions([closed], {
      now: 1_700_000_360,
      stopLossPercent: -40,
      takeProfitMultiples: [2, 3, 5],
    });

    expect(text).toContain('Recent closed paper trades:');
    expect(text).toContain('#3 $MOM — PAPER CLOSED');
    expect(text).toContain('size: 0.100 SOL simulated | realized: +48.3% (+0.048 SOL est)');
    expect(text).toContain('entry: $0.0000097913 → exit: $0.0000145200 (held 29s)');
    expect(text).toContain('peak: 1.48x | reason: 2+ tracked wallets sold inside exit window');
    expect(text).toContain('token: MomCoi...pump | signal #181 | closed 5m ago');
  });
});

describe('formatWalletPerformance', () => {
  it('prints a wallet alpha scoreboard with trust recommendations and execution stats', () => {
    const wallets: WalletPerformance[] = [
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
        sampleSymbols: ['MOM', 'AVICI'],
      },
      {
        address: 'walletB22222222222222222222222222222222222',
        label: 'alpha_b',
        currentTrust: 0.6,
        suggestedTrust: 0.5,
        signals: 12,
        passedSignals: 3,
        passRatePercent: 25,
        paperTrades: 3,
        closedTrades: 3,
        openTrades: 0,
        openExposureSol: 0,
        winRatePercent: 0,
        avgPnlPercent: -31.4,
        medianPnlPercent: -30,
        avgSlippageBps: 40,
        avgLatestWalletToFillSeconds: 18,
        avgSignalToFillSeconds: 0,
        badSignalStreak: 3,
        recommendation: 'demote',
        alphaScore: 22,
        reason: 'closed losses',
        sampleSymbols: ['LOSS'],
      },
    ];

    const text = formatWalletPerformance(wallets, 5);

    expect(text).toContain('Wallet Alpha Scoreboard:');
    expect(text).toContain('#1 alpha_a wallet...1111 — promote | alpha 88/100');
    expect(text).toContain('signals: 7 total | 5 passed (71.4%) | trades: 5 paper / 4 closed / 1 open');
    expect(text).toContain('closed PnL: +24.2% avg | +18.5% median | 75.0% win | bad streak 0');
    expect(text).toContain('exec: +14.8 bps avg slip | latest wallet→fill avg 8s');
    expect(text).toContain('trust: 0.55 (suggested 0.60, tracked only) | open exposure 0.080 SOL');
    expect(text).toContain('#2 alpha_b wallet...2222 — demote | alpha 22/100');
  });

  it('handles no wallet history yet', () => {
    expect(formatWalletPerformance([])).toBe('No wallet performance history yet.');
  });
});

describe('normalizeSignalReasonText', () => {
  it('renames historical $0 pump.fun liquidity failures as pre-graduation liquidity unavailable', () => {
    const scoreJson = JSON.stringify({
      snapshot: {
        liquidityUsd: 0,
        dexId: 'pumpfun',
        marketStage: 'pumpfun_bonding_curve',
      },
    });

    expect(normalizeSignalReasonText('liquidity too thin at $0', scoreJson)).toBe('DEX liquidity unavailable / likely pre-graduation');
  });

  it('renames historical $0 non-pump liquidity failures as no usable pool', () => {
    const scoreJson = JSON.stringify({
      snapshot: {
        liquidityUsd: 0,
        dexId: 'raydium',
        marketStage: 'unknown',
      },
    });

    expect(normalizeSignalReasonText('liquidity too thin at $0', scoreJson)).toBe('DEX liquidity unavailable / no usable pool');
  });
});
