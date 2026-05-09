import { afterEach, describe, expect, it, vi } from 'vitest';
import { SolanaRpcClient } from '../src/rpc';

describe('SolanaRpcClient rate-limit handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries transient 429 responses instead of failing the scan immediately', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [{ signature: 'sig1' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const rpc = new SolanaRpcClient('https://rpc.example.invalid', {
      maxRetries: 1,
      retryBaseMs: 0,
      retryMaxMs: 0,
      minIntervalMs: 0,
      timeoutMs: 1_000,
    });

    const signatures = await rpc.getSignaturesForAddress('wallet1', 10);

    expect(signatures).toEqual([{ signature: 'sig1' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats Retry-After as a minimum delay even when jitter is low', async () => {
    const waits: number[] = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'retry-after': '5' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const rpc = new SolanaRpcClient('https://rpc.example.invalid', {
      maxRetries: 1,
      retryBaseMs: 1_000,
      retryMaxMs: 1_000,
      minIntervalMs: 0,
      timeoutMs: 1_000,
      random: () => 0,
      sleep: async (ms: number) => { waits.push(ms); },
    });

    await rpc.getSignaturesForAddress('wallet1', 1);

    expect(waits[0]).toBeGreaterThanOrEqual(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('paces consecutive RPC requests through a shared limiter', async () => {
    const waits: number[] = [];
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const rpc = new SolanaRpcClient('https://rpc.example.invalid', {
      maxRetries: 0,
      minIntervalMs: 125,
      timeoutMs: 1_000,
      sleep: async (ms: number) => { waits.push(ms); },
      now: (() => {
        let now = 0;
        return () => now;
      })(),
    });

    await rpc.getSignaturesForAddress('wallet1', 1);
    await rpc.getSignaturesForAddress('wallet2', 1);

    expect(waits).toContain(125);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('records every retry attempt so quota telemetry matches provider request volume', async () => {
    const attempts: string[] = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const rpc = new SolanaRpcClient('https://rpc.example.invalid', {
      maxRetries: 1,
      retryBaseMs: 0,
      retryMaxMs: 0,
      minIntervalMs: 0,
      timeoutMs: 1_000,
      onRequest: log => attempts.push(`${log.status}:${log.httpStatus ?? ''}:${log.credits}`),
    });

    await rpc.getSignaturesForAddress('wallet1', 1);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(attempts).toEqual(['http_error:429:1', 'ok:200:1']);
  });

  it('records JSON-RPC error responses as rpc_error instead of ok', async () => {
    const attempts: string[] = [];
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32005, message: 'rate limit exceeded' },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const rpc = new SolanaRpcClient('https://rpc.example.invalid', {
      maxRetries: 0,
      minIntervalMs: 0,
      timeoutMs: 1_000,
      onRequest: log => attempts.push(`${log.status}:${log.httpStatus ?? ''}:${log.credits}`),
    });

    await expect(rpc.getSignaturesForAddress('wallet1', 1)).rejects.toThrow(/rate limit exceeded/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(attempts).toEqual(['rpc_error:200:1']);
  });

  it('records malformed HTTP 200 RPC payloads as rpc_error', async () => {
    const attempts: string[] = [];
    const fetchMock = vi.fn().mockResolvedValue(new Response('not-json', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const rpc = new SolanaRpcClient('https://rpc.example.invalid', {
      maxRetries: 0,
      minIntervalMs: 0,
      timeoutMs: 1_000,
      onRequest: log => attempts.push(`${log.status}:${log.httpStatus ?? ''}:${log.credits}`),
    });

    await expect(rpc.getSignaturesForAddress('wallet1', 1)).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(attempts).toEqual(['rpc_error:200:1']);
  });

  it('checks budget before each retry attempt and stops before crossing the hard cap', async () => {
    let remainingAttempts = 1;
    const fetchMock = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }));
    vi.stubGlobal('fetch', fetchMock);

    const rpc = new SolanaRpcClient('https://rpc.example.invalid', {
      maxRetries: 2,
      retryBaseMs: 0,
      retryMaxMs: 0,
      minIntervalMs: 0,
      timeoutMs: 1_000,
      beforeRequest: () => ({ allowed: remainingAttempts-- > 0, reason: 'hard cap' }),
    });

    await expect(rpc.getSignaturesForAddress('wallet1', 1)).rejects.toThrow(/blocked by API budget/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
