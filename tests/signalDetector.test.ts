import { describe, expect, it } from 'vitest';
import { SignalDetector } from '../src/signalDetector';
import type { WalletSwapEvent } from '../src/types';

function buy(wallet: string, token: string, timestamp: number): WalletSwapEvent {
  return {
    wallet,
    tokenAddress: token,
    direction: 'buy',
    solAmount: 1,
    txHash: `${wallet}-${token}-${timestamp}`,
    timestamp,
    source: 'pumpfun'
  };
}

describe('SignalDetector', () => {
  it('emits a convergence signal when two distinct wallets buy same token inside window', () => {
    const detector = new SignalDetector({ minWallets: 2, windowSeconds: 300 });
    const first = detector.onBuyEvent(buy('walletA', 'mintX', 1000));
    const second = detector.onBuyEvent(buy('walletB', 'mintX', 1100));

    expect(first).toBeNull();
    expect(second).not.toBeNull();
    expect(second?.tokenAddress).toBe('mintX');
    expect(second?.walletCount).toBe(2);
    expect(second?.wallets.map(w => w.wallet).sort()).toEqual(['walletA', 'walletB']);
  });

  it('does not count duplicate buys from the same wallet as convergence', () => {
    const detector = new SignalDetector({ minWallets: 2, windowSeconds: 300 });
    detector.onBuyEvent(buy('walletA', 'mintX', 1000));
    const signal = detector.onBuyEvent(buy('walletA', 'mintX', 1100));

    expect(signal).toBeNull();
  });

  it('expires old wallet buys outside the convergence window', () => {
    const detector = new SignalDetector({ minWallets: 2, windowSeconds: 300 });
    detector.onBuyEvent(buy('walletA', 'mintX', 1000));
    const signal = detector.onBuyEvent(buy('walletB', 'mintX', 1401));

    expect(signal).toBeNull();
  });

  it('emits only one signal per token per active window', () => {
    const detector = new SignalDetector({ minWallets: 2, windowSeconds: 300 });
    detector.onBuyEvent(buy('walletA', 'mintX', 1000));
    const firstSignal = detector.onBuyEvent(buy('walletB', 'mintX', 1100));
    const duplicateSignal = detector.onBuyEvent(buy('walletC', 'mintX', 1150));

    expect(firstSignal).not.toBeNull();
    expect(duplicateSignal).toBeNull();
  });
});
