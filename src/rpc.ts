import { AsyncRateLimiter, fetchWithTimeoutAndRetry, type SleepFn } from './rateLimit';

export interface SolanaRpcRequestLog {
  method: string;
  status: 'ok' | 'http_error' | 'rpc_error' | 'network_error';
  httpStatus?: number;
  credits: number;
}

export interface SolanaRpcBudgetDecision {
  allowed: boolean;
  reason: string;
}

export interface SolanaRpcClientOptions {
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  minIntervalMs?: number;
  sleep?: SleepFn;
  now?: () => number;
  random?: () => number;
  onRequest?: (log: SolanaRpcRequestLog) => void;
  beforeRequest?: (method: string, estimatedCredits: number) => SolanaRpcBudgetDecision;
}

const DEFAULT_RPC_TIMEOUT_MS = 15_000;
const DEFAULT_RPC_MAX_RETRIES = 5;
const DEFAULT_RPC_RETRY_BASE_MS = 1_000;
const DEFAULT_RPC_RETRY_MAX_MS = 30_000;
// Helius Free RPC is 10 rps; pace below that by default so bursts do not trip 429s.
const DEFAULT_RPC_MIN_INTERVAL_MS = 125;

export class SolanaRpcClient {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly sleep?: SleepFn;
  private readonly random?: () => number;
  private readonly onRequest?: (log: SolanaRpcRequestLog) => void;
  private readonly beforeRequest?: (method: string, estimatedCredits: number) => SolanaRpcBudgetDecision;
  private readonly limiter: AsyncRateLimiter;

  constructor(private readonly url: string, options: SolanaRpcClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_RPC_MAX_RETRIES;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RPC_RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? DEFAULT_RPC_RETRY_MAX_MS;
    this.sleep = options.sleep;
    this.random = options.random;
    this.onRequest = options.onRequest;
    this.beforeRequest = options.beforeRequest;
    this.limiter = new AsyncRateLimiter({
      minIntervalMs: options.minIntervalMs ?? DEFAULT_RPC_MIN_INTERVAL_MS,
      sleep: options.sleep,
      now: options.now,
    });
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    let res: Response;
    try {
      res = await fetchWithTimeoutAndRetry(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      }, {
        context: `Solana RPC ${method}`,
        limiter: this.limiter,
        timeoutMs: this.timeoutMs,
        maxRetries: this.maxRetries,
        retryBaseMs: this.retryBaseMs,
        retryMaxMs: this.retryMaxMs,
        sleep: this.sleep,
        random: this.random,
        beforeAttempt: () => this.assertBudget(method, 1),
        onAttempt: attempt => {
          if (attempt.error || (attempt.response && !attempt.response.ok)) {
            this.recordAttempt(method, attempt.response, attempt.error);
          }
        },
      });
    } catch (err) {
      throw err;
    }
    if (!res.ok) {
      throw new Error(`Solana RPC HTTP ${res.status} for ${method}`);
    }
    let data: { result?: T; error?: { message?: string; code?: number } };
    try {
      data = await res.json() as { result?: T; error?: { message?: string; code?: number } };
    } catch (err) {
      this.recordRequest({ method, status: 'rpc_error', httpStatus: res.status, credits: 1 });
      throw err;
    }
    if (data.error) {
      this.recordRequest({ method, status: 'rpc_error', httpStatus: res.status, credits: 1 });
      throw new Error(`Solana RPC ${method} failed: ${data.error.message ?? data.error.code}`);
    }
    this.recordRequest({ method, status: 'ok', httpStatus: res.status, credits: 1 });
    return data.result as T;
  }

  private assertBudget(method: string, estimatedCredits: number): void {
    const decision = this.beforeRequest?.(method, estimatedCredits);
    if (decision && !decision.allowed) {
      throw new Error(`Solana RPC ${method} blocked by API budget: ${decision.reason}`);
    }
  }

  private recordAttempt(method: string, response?: Response, error?: unknown): void {
    if (response) {
      this.recordRequest({
        method,
        status: response.ok ? 'ok' : 'http_error',
        httpStatus: response.status,
        credits: 1,
      });
      return;
    }
    if (error) this.recordRequest({ method, status: 'network_error', credits: 1 });
  }

  private recordRequest(log: SolanaRpcRequestLog): void {
    try {
      this.onRequest?.(log);
    } catch {
      // Usage accounting must never break scanning.
    }
  }

  async getSignaturesForAddress(address: string, limit: number, before?: string): Promise<Array<{ signature: string; blockTime?: number | null; err?: unknown }>> {
    const options: Record<string, unknown> = { limit, commitment: 'confirmed' };
    if (before) options.before = before;
    return this.call('getSignaturesForAddress', [address, options]);
  }

  async getParsedTransaction(signature: string): Promise<any | null> {
    return this.call('getTransaction', [signature, {
      encoding: 'jsonParsed',
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    }]);
  }
}
