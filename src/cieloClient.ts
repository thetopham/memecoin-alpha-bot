import { AsyncRateLimiter, fetchWithTimeoutAndRetry } from './rateLimit';

export interface CieloClientConfig {
  apiKey?: string;
  apiBaseUrl: string;
  appBaseUrl: string;
  timeoutMs?: number;
}

export interface CieloWalletDiscoveryParams {
  type?: 'solana' | 'evm';
  sort?: string;
  timeframe?: string;
  pages?: number;
}

export interface CieloPublicListsParams {
  search?: string;
  order?: 'popular' | 'new';
  size?: number;
  pages?: number;
}

export interface CieloFeedParams {
  wallet?: string;
  list?: number | string;
  chains?: string[];
  txTypes?: string[];
  tokens?: string[];
  minUSD?: number;
  maxUSD?: number;
  newTrades?: boolean;
  limit?: number;
  startFrom?: string;
  fromTimestamp?: number;
  toTimestamp?: number;
  includeMarketCap?: boolean;
}

export interface CieloTrendingTokenParams {
  chain?: 'solana' | 'base' | 'all';
  interval?: '1m' | '5m' | '1h' | '6h' | '24h';
  limit?: number;
  sortBy?: string;
}

export interface CieloWalletsByTagParams {
  tags: string[];
  walletType?: 'solana' | 'evm';
  limit?: number;
  nextObject?: string;
}

export interface CieloPulseParams {
  category: 'new_pairs' | 'almost_migrated' | 'migrated';
  limit?: number;
  protocols?: string[];
}

export interface CieloHttpResult<T = unknown> {
  status: number;
  data: T;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const cieloApiLimiter = new AsyncRateLimiter({ minIntervalMs: 125 }); // Cielo Free: 10 credits/sec; keep a buffer.
const cieloAppLimiter = new AsyncRateLimiter({ minIntervalMs: 500 }); // Undocumented app tRPC fallback; keep conservative.

export const CIELO_PULSE_PROTOCOLS = [
  'raydium-v4',
  'pump-fun',
  'boop-fun',
  'heaven',
  'moonit',
  'believe',
  'token-mill',
  'bonk',
  'launchlab',
  'bags',
  'moonshot',
  'daos',
  'jupstudio',
];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function setParam(params: URLSearchParams, key: string, value: unknown): void {
  if (value == null || value === '') return;
  if (Array.isArray(value)) {
    const filtered = value.filter(v => v != null && v !== '').map(String);
    if (filtered.length) params.set(key, filtered.join(','));
    return;
  }
  params.set(key, String(value));
}

function buildUrl(baseUrl: string, pathname: string, query: Record<string, unknown> = {}): string {
  const url = new URL(pathname, `${cleanBaseUrl(baseUrl)}/`);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) setParam(params, key, value);
  const queryString = params.toString();
  if (queryString) url.search = queryString;
  return url.toString();
}

function responseMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  const message = record.message ?? record.error ?? record.detail ?? record.title;
  return typeof message === 'string' ? message : undefined;
}

async function fetchJson<T = unknown>(url: string, init: RequestInit, timeoutMs: number, limiter: AsyncRateLimiter, context: string): Promise<CieloHttpResult<T>> {
  const response = await fetchWithTimeoutAndRetry(url, init, {
    context,
    limiter,
    timeoutMs,
    maxRetries: 3,
    retryBaseMs: 1_000,
    retryMaxMs: 30_000,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) as T : undefined as T;
  if (!response.ok && response.status !== 202) {
    const message = responseMessage(data) ?? response.statusText;
    throw new Error(`Cielo request failed (${response.status}): ${message}`);
  }
  return { status: response.status, data };
}

function unwrapApiPayload<T = unknown>(payload: unknown): T {
  if (!payload || typeof payload !== 'object') return payload as T;
  const record = payload as Record<string, unknown>;
  if (record.status === 'error') {
    throw new Error(responseMessage(record) ?? 'Cielo API returned error status');
  }
  if ('data' in record && (record.status === 'ok' || record.status === 'success')) return record.data as T;
  return payload as T;
}

function unwrapTrpcPayload<T = unknown>(payload: unknown): T {
  if (!Array.isArray(payload)) throw new Error('Unexpected Cielo app tRPC response shape');
  const first = payload[0] as Record<string, unknown> | undefined;
  if (!first) throw new Error('Empty Cielo app tRPC response');
  if ('error' in first) {
    const err = first.error as Record<string, unknown> | undefined;
    throw new Error(`Cielo app tRPC error: ${responseMessage(err) ?? JSON.stringify(err)}`);
  }
  const result = first.result as Record<string, unknown> | undefined;
  const data = result?.data as Record<string, unknown> | undefined;
  if (!data || !('json' in data)) throw new Error('Missing json payload in Cielo app tRPC response');
  return data.json as T;
}

export function responseArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  for (const key of ['data', 'items', 'results', 'wallets', 'tokens', 'lists', 'rows']) {
    const value = record[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      const nested = responseArray(value);
      if (nested.length) return nested;
    }
  }
  return [];
}

export function responsePaging(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  const paging = record.paging;
  return paging && typeof paging === 'object' ? paging as Record<string, unknown> : undefined;
}

export class CieloClient {
  private readonly apiKey?: string;
  private readonly apiBaseUrl: string;
  private readonly appBaseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: CieloClientConfig) {
    this.apiKey = config.apiKey;
    this.apiBaseUrl = cleanBaseUrl(config.apiBaseUrl);
    this.appBaseUrl = cleanBaseUrl(config.appBaseUrl);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  hasApiKey(): boolean {
    return Boolean(this.apiKey);
  }

  private async apiGet<T = unknown>(pathname: string, query: Record<string, unknown> = {}, retries = 2): Promise<T> {
    if (!this.apiKey) throw new Error('CIELO_API_KEY is not configured');
    const url = buildUrl(this.apiBaseUrl, pathname, query);
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const result = await fetchJson(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-api-key': this.apiKey,
          'user-agent': 'memecoin-alpha-bot/0.1 dry-run wallet-discovery',
        },
      }, this.timeoutMs, cieloApiLimiter, `Cielo API ${pathname}`);
      if (result.status !== 202) return unwrapApiPayload<T>(result.data);
      if (attempt === retries) throw new Error(`Cielo API data still not ready after ${retries + 1} attempts: ${pathname}`);
      await sleep(10_000);
    }
    throw new Error(`Cielo API request did not complete: ${pathname}`);
  }

  private async appTrpcGet<T = unknown>(procedure: string, input: unknown): Promise<T> {
    const envelope = { 0: { json: input } };
    const url = buildUrl(this.appBaseUrl, `/api/trpc/${procedure}`, {
      batch: 1,
      input: JSON.stringify(envelope),
    });
    const result = await fetchJson(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'memecoin-alpha-bot/0.1 dry-run wallet-discovery',
      },
    }, this.timeoutMs, cieloAppLimiter, `Cielo app ${procedure}`);
    return unwrapTrpcPayload<T>(result.data);
  }

  async getWalletDiscovery(params: CieloWalletDiscoveryParams = {}): Promise<unknown[]> {
    const pages = Math.max(1, params.pages ?? 1);
    const rows: unknown[] = [];
    for (let page = 1; page <= pages; page += 1) {
      const payload = await this.appTrpcGet('walletDiscovery.getWalletDiscovery', {
        endpoint: '/v2/discovery/wallets',
        type: params.type ?? 'solana',
        sort: params.sort ?? 'trending',
        range: {},
        timeframe: params.timeframe ?? '30d',
        cursor: String(page),
        direction: 'forward',
      });
      rows.push(...responseArray(payload));
      const paging = responsePaging(payload);
      const totalPages = Number(paging?.total_pages ?? paging?.totalPages ?? pages);
      if (Number.isFinite(totalPages) && page >= totalPages) break;
    }
    return rows;
  }

  async getPublicLists(params: CieloPublicListsParams = {}): Promise<unknown[]> {
    const pages = Math.max(1, params.pages ?? 1);
    const size = Math.max(1, Math.min(50, params.size ?? 50));
    const rows: unknown[] = [];
    let cursor = '';
    for (let page = 1; page <= pages; page += 1) {
      const payload = await this.appTrpcGet('lists.getListsInfiniteScroll', {
        search: params.search ?? '',
        order: params.order ?? 'popular',
        followingOnly: false,
        size,
        cursor,
        direction: 'forward',
      });
      rows.push(...responseArray(payload));
      const paging = responsePaging(payload);
      const next = String(paging?.next_object ?? paging?.nextObject ?? paging?.next_cursor ?? '');
      if (!next || next === cursor) break;
      cursor = next;
    }
    return rows;
  }

  async getPulseTokens(params: CieloPulseParams): Promise<unknown[]> {
    const payload = await this.appTrpcGet('trading.getTrenches', {
      category: params.category,
      limit: Math.max(1, Math.min(100, params.limit ?? 50)),
      protocols: params.protocols ?? CIELO_PULSE_PROTOCOLS,
    });
    return responseArray(payload);
  }

  async getTrendingTokens(params: CieloTrendingTokenParams = {}): Promise<unknown[]> {
    const payload = await this.apiGet('/api/v1/trending-tokens', {
      chain: params.chain ?? 'solana',
      interval: params.interval ?? '1h',
      limit: Math.max(1, Math.min(100, params.limit ?? 50)),
      sort_by: params.sortBy ?? 'popular_desc',
    });
    return responseArray(payload);
  }

  async getWalletsByTag(params: CieloWalletsByTagParams): Promise<unknown[]> {
    const payload = await this.apiGet('/api/v1/tags/wallets', {
      tags: params.tags,
      wallet_type: params.walletType ?? 'solana',
      limit: Math.max(1, Math.min(50, params.limit ?? 50)),
      next_object: params.nextObject,
    });
    return responseArray(payload);
  }

  async getAllLists(order: 'popular' | 'new' = 'popular'): Promise<unknown[]> {
    const payload = await this.apiGet('/api/v1/lists/all', { order, follow_only: false });
    return responseArray(payload);
  }

  async getFeed(params: CieloFeedParams): Promise<unknown[]> {
    const payload = await this.apiGet('/api/v1/feed', {
      wallet: params.wallet,
      list: params.list,
      chains: params.chains,
      txTypes: params.txTypes,
      tokens: params.tokens,
      minUSD: params.minUSD,
      maxUSD: params.maxUSD,
      newTrades: params.newTrades,
      limit: Math.max(1, Math.min(100, params.limit ?? 100)),
      startFrom: params.startFrom,
      fromTimestamp: params.fromTimestamp,
      toTimestamp: params.toTimestamp,
      includeMarketCap: params.includeMarketCap,
    });
    return responseArray(payload);
  }
}
