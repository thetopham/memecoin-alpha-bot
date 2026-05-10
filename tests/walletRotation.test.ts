import { describe, expect, it } from 'vitest';
import { applyWalletRotation, syncCandidateWallets, walletTierCounts } from '../src/walletRotation';
import type { WalletConfig, WalletPerformance } from '../src/types';

const basePerf: WalletPerformance = {
  address: '11111111111111111111111111111111',
  label: 'base',
  currentTrust: 0.5,
  suggestedTrust: 0.5,
  signals: 0,
  passedSignals: 0,
  passRatePercent: null,
  paperTrades: 0,
  closedTrades: 0,
  openTrades: 0,
  openExposureSol: 0,
  winRatePercent: null,
  avgPnlPercent: null,
  medianPnlPercent: null,
  avgSlippageBps: null,
  avgLatestWalletToFillSeconds: null,
  avgSignalToFillSeconds: null,
  badSignalStreak: 0,
  recommendation: 'keep',
  alphaScore: 50,
  reason: 'test',
  sampleSymbols: [],
};

function perf(address: string, alphaScore: number, recommendation: WalletPerformance['recommendation'], suggestedTrust = 0.5): WalletPerformance {
  return { ...basePerf, address, label: address.slice(0, 4), alphaScore, recommendation, suggestedTrust };
}

describe('wallet rotation', () => {
  it('promotes only the best wallets to hot tier and archives persistent losers when applying Developer-plan limits', () => {
    const wallets: WalletConfig[] = [
      { address: '11111111111111111111111111111111', label: 'a', trust: 0.5, tier: 'probation', enabled: true },
      { address: '22222222222222222222222222222222', label: 'b', trust: 0.5, tier: 'probation', enabled: true },
      { address: '33333333333333333333333333333333', label: 'c', trust: 0.5, tier: 'hot', enabled: true },
      { address: '44444444444444444444444444444444', label: 'd', trust: 0.5, tier: 'hot', enabled: true },
      { address: '55555555555555555555555555555555', label: 'e', trust: 0.5, tier: 'candidate', enabled: true },
    ];
    const performance = [
      perf(wallets[0].address, 95, 'promote', 0.7),
      perf(wallets[1].address, 84, 'promote', 0.65),
      perf(wallets[2].address, 42, 'probation', 0.45),
      perf(wallets[3].address, 12, 'disable_candidate', 0),
      perf(wallets[4].address, 55, 'keep', 0.5),
    ];

    const rotated = applyWalletRotation(wallets, performance, {
      enabled: true,
      hotWalletLimit: 2,
      probationWalletLimit: 2,
      candidateWalletLimit: 1,
      nowIso: '2026-05-09T16:00:00.000Z',
    });

    expect(rotated.wallets.find(w => w.address === wallets[0].address)?.tier).toBe('hot');
    expect(rotated.wallets.find(w => w.address === wallets[1].address)?.tier).toBe('hot');
    expect(rotated.wallets.find(w => w.address === wallets[2].address)?.tier).toBe('probation');
    expect(rotated.wallets.find(w => w.address === wallets[3].address)?.enabled).toBe(false);
    expect(rotated.wallets.find(w => w.address === wallets[3].address)?.tier).toBe('archive');
    expect(rotated.wallets.find(w => w.address === wallets[4].address)?.tier).toBe('candidate');
    expect(rotated.wallets.find(w => w.address === wallets[0].address)?.trust).toBe(0.5);
    expect(rotated.wallets.find(w => w.address === wallets[3].address)?.trust).toBe(0.5);
    expect(walletTierCounts(rotated.wallets)).toMatchObject({ hot: 2, probation: 1, candidate: 1, archive: 1 });
    expect(rotated.changes.length).toBeGreaterThanOrEqual(4);
  });

  it('caps candidate auto-add per maintenance run even when the candidate file is large', () => {
    const candidates: WalletConfig[] = [
      { address: '66666666666666666666666666666666', label: 'c1' },
      { address: '77777777777777777777777777777777', label: 'c2' },
      { address: '88888888888888888888888888888888', label: 'c3' },
    ];

    const synced = syncCandidateWallets([], candidates, {
      enabled: true,
      candidateWalletLimit: 500,
      maxAddsPerRun: 2,
      nowIso: '2026-05-09T16:00:00.000Z',
    });

    expect(synced.wallets).toHaveLength(2);
    expect(synced.wallets.every(wallet => wallet.tier === 'candidate')).toBe(true);
    expect(synced.changes).toHaveLength(2);
  });
});
