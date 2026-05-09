import type { ConvergenceSignal } from './types';

interface PendingSignalRetry {
  signal: ConvergenceSignal;
  attempt: number;
  nextRetryAt: number;
}

export class SignalRetryQueue {
  private readonly pending = new Map<string, PendingSignalRetry>();

  constructor(private readonly retryDelaysSeconds = [30, 90, 180, 480]) {}

  add(signal: ConvergenceSignal, nowSeconds: number): void {
    if (this.pending.has(signal.tokenAddress)) return;
    const firstDelay = this.retryDelaysSeconds[0];
    if (firstDelay == null) return;
    this.pending.set(signal.tokenAddress, {
      signal,
      attempt: 0,
      nextRetryAt: nowSeconds + firstDelay,
    });
  }

  due(nowSeconds: number): Array<{ signal: ConvergenceSignal; attempt: number }> {
    return Array.from(this.pending.values())
      .filter(item => item.nextRetryAt <= nowSeconds)
      .sort((a, b) => a.nextRetryAt - b.nextRetryAt)
      .map(item => ({ signal: item.signal, attempt: item.attempt }));
  }

  markFailed(tokenAddress: string, nowSeconds: number): void {
    const item = this.pending.get(tokenAddress);
    if (!item) return;
    const nextAttempt = item.attempt + 1;
    const nextDelay = this.retryDelaysSeconds[nextAttempt];
    if (nextDelay == null) {
      this.pending.delete(tokenAddress);
      return;
    }
    this.pending.set(tokenAddress, {
      signal: item.signal,
      attempt: nextAttempt,
      nextRetryAt: nowSeconds + nextDelay,
    });
  }

  remove(tokenAddress: string): void {
    this.pending.delete(tokenAddress);
  }

  size(): number {
    return this.pending.size;
  }
}
