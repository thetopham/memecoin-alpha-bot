import { describe, expect, it, vi } from 'vitest';
import { PollingWalletTracker } from '../src/walletTracker';
import type { WalletConfig } from '../src/types';

function fakeDb(initialState: Record<string, string | null> = {}) {
  const state = new Map<string, string>();
  for (const [key, value] of Object.entries(initialState)) {
    if (value != null) state.set(key, value);
  }
  return {
    getState: vi.fn((key: string) => state.get(key) ?? null),
    setState: vi.fn((key: string, value: string) => { state.set(key, value); }),
    state,
  };
}

describe('PollingWalletTracker resilience', () => {
  it('isolates per-wallet RPC failures so one rate-limited wallet does not abort the whole scan', async () => {
    const wallets: WalletConfig[] = [
      { address: 'wallet-rate-limited', label: 'bad' },
      { address: 'wallet-ok', label: 'good' },
    ];
    const rpc = {
      getSignaturesForAddress: vi.fn()
        .mockRejectedValueOnce(new Error('Solana RPC HTTP 429 for getSignaturesForAddress'))
        .mockResolvedValueOnce([]),
      getParsedTransaction: vi.fn(),
    };
    const db = fakeDb();
    const tracker = new PollingWalletTracker(rpc as any, db as any, 2);

    await expect(tracker.pollAll(wallets)).resolves.toEqual([]);
    expect(rpc.getSignaturesForAddress).toHaveBeenCalledTimes(2);
  });

  it('does not start a tier cooldown when the signature fetch fails before a wallet scan succeeds', async () => {
    const wallet: WalletConfig = { address: 'wallet-rate-limited', label: 'bad', tier: 'candidate' };
    const rpc = {
      getSignaturesForAddress: vi.fn().mockRejectedValue(new Error('Solana RPC HTTP 429 for getSignaturesForAddress')),
      getParsedTransaction: vi.fn(),
    };
    const db = fakeDb();
    const tracker = new PollingWalletTracker(rpc as any, db as any, 2, {
      now: () => 1_700_000_000,
      scanIntervalsSeconds: { candidate: 3600 },
    });

    await expect(tracker.pollAll([wallet])).resolves.toEqual([]);

    expect(db.setState).not.toHaveBeenCalledWith('last_wallet_scan:wallet-rate-limited', expect.any(String), expect.any(Number));
  });

  it('does not advance a wallet checkpoint past a transaction that failed to fetch or parse', async () => {
    const wallet: WalletConfig = { address: 'wallet1', label: 'tracked' };
    const db = fakeDb({ 'last_signature:wallet1': 'oldSig' });
    const rpc = {
      getSignaturesForAddress: vi.fn().mockResolvedValue([
        { signature: 'newSig', blockTime: 1_700_000_003, err: null },
        { signature: 'retryMe', blockTime: 1_700_000_002, err: null },
        { signature: 'oldSig', blockTime: 1_700_000_001, err: null },
      ]),
      getParsedTransaction: vi.fn()
        .mockRejectedValueOnce(new Error('Solana RPC HTTP 429 for getTransaction')),
    };
    const tracker = new PollingWalletTracker(rpc as any, db as any, 3);

    await tracker.pollWallet(wallet, false);

    expect(db.state.get('last_signature:wallet1')).toBe('oldSig');
    expect(db.setState).not.toHaveBeenCalledWith('last_signature:wallet1', 'newSig', expect.any(Number));
  });

  it('does not advance a wallet checkpoint past a null transaction response', async () => {
    const wallet: WalletConfig = { address: 'wallet1', label: 'tracked' };
    const db = fakeDb({ 'last_signature:wallet1': 'oldSig' });
    const rpc = {
      getSignaturesForAddress: vi.fn().mockResolvedValue([
        { signature: 'newSig', blockTime: 1_700_000_003, err: null },
        { signature: 'retryNull', blockTime: 1_700_000_002, err: null },
        { signature: 'oldSig', blockTime: 1_700_000_001, err: null },
      ]),
      getParsedTransaction: vi.fn().mockResolvedValueOnce(null),
    };
    const tracker = new PollingWalletTracker(rpc as any, db as any, 3);

    await tracker.pollWallet(wallet, false);

    expect(rpc.getParsedTransaction).toHaveBeenCalledTimes(1);
    expect(db.state.get('last_signature:wallet1')).toBe('oldSig');
    expect(db.setState).not.toHaveBeenCalledWith('last_signature:wallet1', 'newSig', expect.any(Number));
    expect(db.setState).not.toHaveBeenCalledWith('last_signature:wallet1', 'retryNull', expect.any(Number));
  });

  it('does not impose the full tier cooldown when transaction processing is interrupted', async () => {
    let currentTime = 1_700_000_000;
    const wallet: WalletConfig = { address: 'candidate-wallet', label: 'candidate', tier: 'candidate' };
    const db = fakeDb({ 'last_signature:candidate-wallet': 'oldSig' });
    const rpc = {
      getSignaturesForAddress: vi.fn()
        .mockResolvedValueOnce([
          { signature: 'newSig', blockTime: currentTime + 2, err: null },
          { signature: 'retryNull', blockTime: currentTime + 1, err: null },
          { signature: 'oldSig', blockTime: currentTime, err: null },
        ])
        .mockResolvedValueOnce([]),
      getParsedTransaction: vi.fn().mockResolvedValueOnce(null),
    };
    const tracker = new PollingWalletTracker(rpc as any, db as any, 3, {
      now: () => currentTime,
      scanIntervalsSeconds: { candidate: 3600 },
    });

    await tracker.pollWallet(wallet, false);
    expect(db.setState).not.toHaveBeenCalledWith('last_wallet_scan:candidate-wallet', String(currentTime), currentTime);

    currentTime += 1;
    await tracker.pollWallet(wallet, false);

    expect(rpc.getSignaturesForAddress).toHaveBeenCalledTimes(2);
    expect(db.setState).toHaveBeenCalledWith('last_wallet_scan:candidate-wallet', String(currentTime), currentTime);
  });

  it('honors tier scan intervals so probation/candidate wallets do not burn hot-wallet quota every loop', async () => {
    const wallets: WalletConfig[] = [
      { address: 'hot-wallet', label: 'hot', tier: 'hot' },
      { address: 'probation-wallet', label: 'probation', tier: 'probation' },
      { address: 'candidate-wallet', label: 'candidate', tier: 'candidate' },
    ];
    const now = 1_700_000_000;
    const db = fakeDb({
      'last_wallet_scan:probation-wallet': String(now - 60),
      'last_wallet_scan:candidate-wallet': String(now - 60),
    });
    const rpc = {
      getSignaturesForAddress: vi.fn().mockResolvedValue([]),
      getParsedTransaction: vi.fn(),
    };
    const tracker = new PollingWalletTracker(rpc as any, db as any, 2, {
      now: () => now,
      scanIntervalsSeconds: { hot: 30, probation: 300, candidate: 3600 },
    });

    await tracker.pollAll(wallets, false);

    expect(rpc.getSignaturesForAddress).toHaveBeenCalledTimes(1);
    expect(rpc.getSignaturesForAddress).toHaveBeenCalledWith('hot-wallet', 2, undefined);
  });

  it('preflights a conservative full wallet scan cost before spending RPC calls near the cap', async () => {
    const wallet: WalletConfig = { address: 'wallet-budget', label: 'budgeted', tier: 'hot' };
    const db = fakeDb({ 'last_signature:wallet-budget': 'checkpoint' });
    const rpc = {
      getSignaturesForAddress: vi.fn().mockResolvedValue([]),
      getParsedTransaction: vi.fn(),
    };
    const budget = { allowTier: vi.fn(() => ({ allowed: false, reason: 'hard cap' })) };
    const tracker = new PollingWalletTracker(rpc as any, db as any, 8, {
      maxSignaturePages: 10,
      budget,
      now: () => 1_700_000_000,
    });

    await expect(tracker.pollWallet(wallet, false)).resolves.toEqual([]);

    expect(budget.allowTier).toHaveBeenCalledWith('hot', 90, 1_700_000_000);
    expect(rpc.getSignaturesForAddress).not.toHaveBeenCalled();
  });

  it('also preflights historical catch-up scans before spending RPC calls', async () => {
    const wallet: WalletConfig = { address: 'wallet-history-budget', label: 'budgeted', tier: 'hot' };
    const db = fakeDb();
    const rpc = {
      getSignaturesForAddress: vi.fn().mockResolvedValue([]),
      getParsedTransaction: vi.fn(),
    };
    const budget = { allowTier: vi.fn(() => ({ allowed: false, reason: 'hard cap' })) };
    const tracker = new PollingWalletTracker(rpc as any, db as any, 8, {
      maxSignaturePages: 10,
      budget,
      now: () => 1_700_000_000,
    });

    await expect(tracker.pollWallet(wallet, true)).resolves.toEqual([]);

    expect(budget.allowTier).toHaveBeenCalledWith('hot', 90, 1_700_000_000);
    expect(rpc.getSignaturesForAddress).not.toHaveBeenCalled();
  });

  it('paginates signatures until the previous checkpoint is found or a safe page cap is reached', async () => {
    const wallet: WalletConfig = { address: 'wallet1', label: 'tracked' };
    const db = fakeDb({ 'last_signature:wallet1': 'oldSig' });
    const rpc = {
      getSignaturesForAddress: vi.fn()
        .mockResolvedValueOnce([
          { signature: 'newSig2', blockTime: 1_700_000_004, err: null },
          { signature: 'newSig1', blockTime: 1_700_000_003, err: null },
        ])
        .mockResolvedValueOnce([
          { signature: 'newSig0', blockTime: 1_700_000_002, err: null },
          { signature: 'oldSig', blockTime: 1_700_000_001, err: null },
        ]),
      getParsedTransaction: vi.fn().mockResolvedValue({
        meta: { err: null },
        transaction: { message: { accountKeys: [] } },
      }),
    };
    const tracker = new PollingWalletTracker(rpc as any, db as any, 2, { maxSignaturePages: 3 });

    await tracker.pollWallet(wallet, false);

    expect(rpc.getSignaturesForAddress).toHaveBeenNthCalledWith(1, 'wallet1', 2, undefined);
    expect(rpc.getSignaturesForAddress).toHaveBeenNthCalledWith(2, 'wallet1', 2, 'newSig1');
    expect(db.state.get('last_signature:wallet1')).toBe('newSig2');
  });
});
