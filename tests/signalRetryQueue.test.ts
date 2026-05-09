import { describe, expect, it } from 'vitest';
import { SignalRetryQueue } from '../src/signalRetryQueue';
import type { ConvergenceSignal } from '../src/types';

function signal(tokenAddress = 'mint123pump'): ConvergenceSignal {
  return {
    tokenAddress,
    wallets: [
      { wallet: 'walletA', trust: 0.6, solAmount: 1, txHash: 'tx-a', timestamp: 1_000, source: 'pumpfun' },
      { wallet: 'walletB', trust: 0.6, solAmount: 1, txHash: 'tx-b', timestamp: 1_020, source: 'pumpfun' },
    ],
    walletCount: 2,
    weightedTrust: 1.2,
    windowSeconds: 20,
    firstSeen: 1_000,
    lastSeen: 1_020,
    sources: ['pumpfun'],
  };
}

describe('SignalRetryQueue', () => {
  it('retries no-market-data signals with increasing delays and then expires them', () => {
    const queue = new SignalRetryQueue([30, 90, 180]);
    const s = signal();

    queue.add(s, 10_000);

    expect(queue.size()).toBe(1);
    expect(queue.due(10_029)).toEqual([]);
    expect(queue.due(10_030).map(item => item.signal.tokenAddress)).toEqual(['mint123pump']);

    queue.markFailed('mint123pump', 10_030);
    expect(queue.due(10_119)).toEqual([]);
    expect(queue.due(10_120).map(item => item.attempt)).toEqual([1]);

    queue.markFailed('mint123pump', 10_120);
    expect(queue.due(10_299)).toEqual([]);
    expect(queue.due(10_300).map(item => item.attempt)).toEqual([2]);

    queue.markFailed('mint123pump', 10_300);
    expect(queue.size()).toBe(0);
  });

  it('does not duplicate pending retries for the same token', () => {
    const queue = new SignalRetryQueue([30, 90]);
    queue.add(signal('samepump'), 10_000);
    queue.add(signal('samepump'), 10_005);

    expect(queue.size()).toBe(1);
    expect(queue.due(10_030)).toHaveLength(1);
  });
});
