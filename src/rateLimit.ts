export type SleepFn = (ms: number) => Promise<void>;

export interface AsyncRateLimiterOptions {
  minIntervalMs: number;
  sleep?: SleepFn;
  now?: () => number;
}

export interface FetchAttemptResult {
  attempt: number;
  response?: Response;
  error?: unknown;
}

export interface FetchRetryOptions {
  context: string;
  limiter?: AsyncRateLimiter;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  retryJitterPct?: number;
  sleep?: SleepFn;
  random?: () => number;
  beforeAttempt?: (attempt: number) => void | Promise<void>;
  onAttempt?: (result: FetchAttemptResult) => void;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class AsyncRateLimiter {
  private nextAvailableAt = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly minIntervalMs: number;
  private readonly sleep: SleepFn;
  private readonly now: () => number;

  constructor(options: AsyncRateLimiterOptions) {
    this.minIntervalMs = Math.max(0, options.minIntervalMs);
    this.sleep = options.sleep ?? sleep;
    this.now = options.now ?? (() => Date.now());
  }

  async wait(): Promise<void> {
    const task = this.queue.then(async () => {
      if (this.minIntervalMs <= 0) return;
      const waitMs = Math.max(0, this.nextAvailableAt - this.now());
      if (waitMs > 0) await this.sleep(waitMs);
      const startAt = Math.max(this.now(), this.nextAvailableAt);
      this.nextAvailableAt = startAt + this.minIntervalMs;
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
}

export function parseRetryAfterMs(headers: Headers): number | null {
  const value = headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

export function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function backoffDelayMs(attempt: number, response: Response | null, options: Required<Pick<FetchRetryOptions, 'retryBaseMs' | 'retryMaxMs' | 'retryJitterPct' | 'random'>>): number {
  const retryAfter = response ? parseRetryAfterMs(response.headers) : null;
  const exponential = Math.min(options.retryMaxMs, options.retryBaseMs * Math.pow(2, attempt));
  const jitter = exponential > 0 && options.retryJitterPct > 0
    ? 1 + ((options.random() * 2) - 1) * options.retryJitterPct
    : 1;
  const jitteredExponential = Math.max(0, Math.round(exponential * jitter));
  return Math.max(retryAfter ?? 0, jitteredExponential);
}

export async function fetchWithTimeoutAndRetry(url: string, init: RequestInit, options: FetchRetryOptions): Promise<Response> {
  const maxRetries = Math.max(0, options.maxRetries ?? 5);
  const retryBaseMs = Math.max(0, options.retryBaseMs ?? 1_000);
  const retryMaxMs = Math.max(retryBaseMs, options.retryMaxMs ?? 30_000);
  const retryJitterPct = Math.max(0, options.retryJitterPct ?? 0.25);
  const timeoutMs = Math.max(1, options.timeoutMs ?? 15_000);
  const sleepFn = options.sleep ?? sleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    await options.beforeAttempt?.(attempt);
    await options.limiter?.wait();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      options.onAttempt?.({ attempt, response });
      if (!isRetriableStatus(response.status) || attempt === maxRetries) return response;
      const delayMs = backoffDelayMs(attempt, response, { retryBaseMs, retryMaxMs, retryJitterPct, random });
      if (delayMs > 0) await sleepFn(delayMs);
    } catch (err) {
      options.onAttempt?.({ attempt, error: err });
      lastError = err;
      if (attempt === maxRetries) break;
      const delayMs = backoffDelayMs(attempt, null, { retryBaseMs, retryMaxMs, retryJitterPct, random });
      if (delayMs > 0) await sleepFn(delayMs);
    } finally {
      clearTimeout(timer);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error');
  throw new Error(`${options.context} failed after ${maxRetries + 1} attempts: ${message}`);
}
