import fs from 'fs';
import path from 'path';
import { loadConfig } from './config';
import { CIELO_PULSE_PROTOCOLS, CieloClient, responseArray } from './cieloClient';
import { SolanaRpcClient } from './rpc';
import { applyResults, evaluateCandidates, type WalletCandidate, type WalletVetDecision, type WalletVetResult, writeVettingReport } from './walletEvaluator';
import { isSolanaWalletAddress, normalizeWallet } from './wallets';
import type { AppConfig } from './types';

interface CieloDiscoveryOptions {
  apply: boolean;
  includeProbation: boolean;
  json: boolean;
  useApp: boolean;
  useApi: boolean;
  candidatePath: string;
  outputPath: string;
  vettingReportPath: string;
  maxCandidates: number;
  pages: number;
  signatureLimit: number;
}

interface CieloCandidateMeta {
  score: number;
  sources: string[];
  reasons: string[];
  metrics: Record<string, unknown>;
  discoveredAt: string;
}

export interface CieloDiscoveredCandidate extends WalletCandidate {
  cielo: CieloCandidateMeta;
}

interface CandidateEvidence {
  address: string;
  label: string;
  source: string;
  score: number;
  reasons: string[];
  metrics: Record<string, unknown>;
  rank?: number;
}

interface SourceSummary {
  source: string;
  fetched: number;
  candidates: number;
  skipped: number;
  errors: string[];
}

interface CieloDiscoveryResult {
  generatedAt: string;
  candidatePath: string;
  outputPath: string;
  apply: boolean;
  apiKeyConfigured: boolean;
  sources: SourceSummary[];
  candidates: CieloDiscoveredCandidate[];
  vetting?: {
    reportPath: string;
    added: number;
    counts: Record<WalletVetDecision, number>;
    results: WalletVetResult[];
  };
}

// Cielo currently rejects column ids such as pnl_1d/winrate as app API sort values on the
// wallet-discovery endpoint. The trending surface still includes the PnL/ROI/winrate columns,
// so we fetch trending and score locally instead of spamming invalid sort probes.
const DISCOVERY_SORTS = ['trending'];
const API_TAGS = ['human_operated', 'gem_finder', 'high_win_rate', 'popular_wallet'];
const PUBLIC_LIST_TERMS = ['solana', 'pump', 'fomo', 'top pnl', 'trader', 'wallet tracker', 'gmgn'];
const TOKEN_FEED_BATCH_SIZE = 5;
const MAX_TOKEN_FEED_TOKENS = 20;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.replace(/[$,%]/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function getPath(value: unknown, pathParts: string[]): unknown {
  let current = value;
  for (const part of pathParts) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[part];
  }
  return current;
}

function numberAt(value: unknown, ...paths: string[][]): number | undefined {
  for (const parts of paths) {
    const found = asNumber(getPath(value, parts));
    if (found != null) return found;
  }
  return undefined;
}

function stringAt(value: unknown, ...paths: string[][]): string | undefined {
  for (const parts of paths) {
    const found = asString(getPath(value, parts));
    if (found) return found;
  }
  return undefined;
}

function hoursSince(unixSeconds?: number): number | null {
  if (!unixSeconds) return null;
  return Math.max(0, (Date.now() / 1000 - unixSeconds) / 3600);
}

function formatUsd(value?: number): string {
  if (value == null) return 'n/a';
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function sanitizeLabel(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'cielo_candidate';
}

function readJsonArray(filePath: string): Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(item => item && typeof item === 'object') as Record<string, unknown>[];
}

function readKnownAddresses(paths: string[]): Set<string> {
  const addresses = new Set<string>();
  for (const filePath of paths) {
    for (const item of readJsonArray(filePath)) {
      const address = asString(item.address);
      if (address && isSolanaWalletAddress(address)) addresses.add(address);
    }
  }
  return addresses;
}

function extractTags(row: unknown): string[] {
  const walletTags = getPath(row, ['wallet', 'tags']);
  const directTags = getPath(row, ['tags']);
  const tags = Array.isArray(walletTags) ? walletTags : Array.isArray(directTags) ? directTags : [];
  return tags.map(tag => {
    if (typeof tag === 'string') return tag;
    const record = asRecord(tag);
    return asString(record?.key) ?? asString(record?.tag);
  }).filter((tag): tag is string => Boolean(tag)).map(tag => tag.toLowerCase());
}

function pnlMetric(row: unknown, key: string): { pnlUsd?: number; roi?: number } {
  const root = getPath(row, [key]);
  return {
    pnlUsd: numberAt(root, ['pnl_usd', 'value'], ['pnlUsd'], ['pnl_usd'], ['usd']),
    roi: numberAt(root, ['roi']),
  };
}

function scoreWalletDiscoveryRow(row: unknown, cfg: AppConfig, rank: number, sort: string): CandidateEvidence | null {
  const address = stringAt(row, ['wallet', 'address'], ['address'], ['wallet_address']);
  if (!address || !isSolanaWalletAddress(address)) return null;
  const walletType = stringAt(row, ['wallet_type']);
  if (walletType && walletType !== 'solana') return null;

  const p1 = pnlMetric(row, 'pnl_1d');
  const p7 = pnlMetric(row, 'pnl_7d');
  const p30 = pnlMetric(row, 'pnl_30d');
  const pnlValues = [p1.pnlUsd, p7.pnlUsd, p30.pnlUsd].filter((n): n is number => n != null);
  const roiValues = [p1.roi, p7.roi, p30.roi].filter((n): n is number => n != null);
  const maxPnlUsd = pnlValues.length ? Math.max(...pnlValues) : 0;
  const maxRoi = roiValues.length ? Math.max(...roiValues) : 0;
  const winrate = numberAt(row, ['winrate']) ?? 0;
  const lastActiveTimestamp = numberAt(row, ['timestamp'], ['last_active'], ['wallet', 'last_active']);
  const lastActiveHours = hoursSince(lastActiveTimestamp);
  const averageHoldSeconds = numberAt(row, ['average_hold_time']) ?? null;
  const nativeBalance = numberAt(row, ['native_balance', 'total', 'amount']);
  const nativeSymbol = stringAt(row, ['native_balance', 'total', 'symbol']);
  const tags = extractTags(row);
  const tradingBot = stringAt(row, ['wallet', 'trading_bot']);

  const reasons: string[] = [];
  let score = 0;

  if (maxPnlUsd >= cfg.cieloMinPnlUsd) score += maxPnlUsd >= cfg.cieloMinPnlUsd * 10 ? 35 : 25;
  else reasons.push(`pnl below ${formatUsd(cfg.cieloMinPnlUsd)}`);

  if (maxRoi >= cfg.cieloMinRoiPercent) score += maxRoi >= cfg.cieloMinRoiPercent * 4 ? 20 : 14;
  else reasons.push(`roi below ${cfg.cieloMinRoiPercent}%`);

  if (winrate >= cfg.cieloMinWinratePercent) score += winrate >= 60 ? 22 : 14;
  else reasons.push(`winrate below ${cfg.cieloMinWinratePercent}%`);

  if (lastActiveHours == null) reasons.push('last active timestamp unavailable');
  else if (lastActiveHours <= cfg.cieloMaxLastActiveHours) score += lastActiveHours <= 6 ? 18 : 12;
  else reasons.push(`stale: last trade ${lastActiveHours.toFixed(1)}h ago`);

  if (tags.includes('human_operated')) score += 10;
  if (tags.includes('gem_finder')) score += 8;
  if (tags.includes('high_win_rate')) score += 8;
  if (tags.includes('popular_wallet')) score += 5;
  if (tags.includes('sniper')) {
    score -= 8;
    reasons.push('cielo sniper tag; vetting required');
  }
  if (tradingBot) {
    score -= 8;
    reasons.push(`trading bot label=${tradingBot}`);
  }
  if (averageHoldSeconds != null && averageHoldSeconds < 120) {
    score -= 8;
    reasons.push(`average hold time too short: ${averageHoldSeconds}s`);
  }
  if (nativeSymbol === 'SOL' && nativeBalance != null && nativeBalance >= 0.05) score += 3;

  score = Math.round(clamp(score, 0, 100));
  if (score < 65 || maxPnlUsd < cfg.cieloMinPnlUsd || maxRoi < cfg.cieloMinRoiPercent || winrate < cfg.cieloMinWinratePercent || (lastActiveHours != null && lastActiveHours > cfg.cieloMaxLastActiveHours)) {
    return null;
  }
  if (reasons.length === 0) reasons.push('cielo wallet discovery performance threshold passed');

  return {
    address,
    label: sanitizeLabel(`cielo_discovery_${sort}_rank_${rank}`),
    source: `Cielo Wallet Discovery (${sort}, Solana)`,
    score,
    rank,
    reasons,
    metrics: {
      pnl1dUsd: p1.pnlUsd ?? null,
      roi1d: p1.roi ?? null,
      pnl7dUsd: p7.pnlUsd ?? null,
      roi7d: p7.roi ?? null,
      pnl30dUsd: p30.pnlUsd ?? null,
      roi30d: p30.roi ?? null,
      maxPnlUsd,
      maxRoi,
      winrate,
      lastActiveHours,
      averageHoldSeconds,
      nativeBalance,
      nativeSymbol,
      tags,
    },
  };
}

function extractWalletAddress(row: unknown): string | undefined {
  const address = stringAt(row, ['wallet', 'address'], ['address'], ['wallet_address'], ['wallet'], ['trader'], ['trader_address']);
  return address && isSolanaWalletAddress(address) ? address : undefined;
}

function scoreWalletLikeRow(row: unknown, source: string, rank: number): CandidateEvidence | null {
  const address = extractWalletAddress(row);
  if (!address) return null;
  const tags = extractTags(row);
  let score = 48;
  const reasons = ['cielo tag wallet candidate; requires local RPC vetting'];
  if (tags.includes('human_operated')) score += 10;
  if (tags.includes('gem_finder')) score += 8;
  if (tags.includes('high_win_rate')) score += 8;
  if (tags.includes('popular_wallet')) score += 5;
  if (tags.includes('sniper')) score -= 5;
  return {
    address,
    label: sanitizeLabel(`cielo_tag_${rank}`),
    source,
    score: Math.round(clamp(score, 0, 100)),
    rank,
    reasons,
    metrics: { tags },
  };
}

function shouldInspectPublicList(row: unknown): boolean {
  const name = stringAt(row, ['name'])?.toLowerCase() ?? '';
  const description = stringAt(row, ['description'])?.toLowerCase() ?? '';
  const haystack = `${name} ${description}`;
  return PUBLIC_LIST_TERMS.some(term => haystack.includes(term));
}

function listId(row: unknown): number | undefined {
  const id = numberAt(row, ['id'], ['bundle_id']);
  return id != null && Number.isInteger(id) ? id : undefined;
}

function tokenAddress(row: unknown): string | undefined {
  const address = stringAt(row, ['token_address'], ['address'], ['token', 'address'], ['mint'], ['tokenAddress']);
  return address && isSolanaWalletAddress(address) ? address : undefined;
}

function unsafeAddressPath(pathParts: string[]): boolean {
  const joined = pathParts.join('.').toLowerCase();
  return ['token', 'mint', 'pair', 'pool', 'program', 'contract', 'liquidity', 'market', 'ca'].some(term => joined.includes(term));
}

function walletishAddressPath(pathParts: string[]): boolean {
  const joined = pathParts.join('.').toLowerCase();
  return ['wallet', 'trader', 'signer', 'maker', 'owner', 'account', 'user'].some(term => joined.includes(term));
}

export function extractWalletAddressesFromFeedItem(item: unknown): string[] {
  const found = new Set<string>();
  const walk = (value: unknown, pathParts: string[]): void => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (isSolanaWalletAddress(trimmed) && walletishAddressPath(pathParts) && !unsafeAddressPath(pathParts)) {
        found.add(trimmed);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((child, idx) => walk(child, [...pathParts, String(idx)]));
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    for (const [key, child] of Object.entries(record)) walk(child, [...pathParts, key]);
  };
  walk(item, []);
  return [...found];
}

function feedUsdValue(item: unknown): number {
  return numberAt(item, ['amount_usd'], ['usd_amount'], ['total_usd'], ['value_usd'], ['usdValue'], ['amountUSD'], ['total', 'usd']) ?? 0;
}

function feedToken(item: unknown): string | undefined {
  return tokenAddress(item) ?? stringAt(item, ['token_symbol'], ['token', 'symbol'], ['symbol']);
}

function scoreFeedWallet(address: string, items: unknown[], source: string, labelPrefix: string): CandidateEvidence {
  const tokens = new Set(items.map(feedToken).filter((token): token is string => Boolean(token)));
  const usdValues = items.map(feedUsdValue).filter(value => value > 0);
  const maxUsd = usdValues.length ? Math.max(...usdValues) : 0;
  const totalUsd = usdValues.reduce((sum, value) => sum + value, 0);
  let score = 42 + Math.min(20, items.length * 4) + Math.min(15, tokens.size * 5);
  if (maxUsd >= 100) score += 8;
  if (totalUsd >= 500) score += 8;
  score = Math.round(clamp(score, 0, 88));
  return {
    address,
    label: sanitizeLabel(`${labelPrefix}_${address.slice(0, 6)}`),
    source,
    score,
    reasons: ['observed in Cielo feed; not proof of skill until RPC vetting passes'],
    metrics: {
      feedEvents: items.length,
      distinctTokens: tokens.size,
      maxUsd,
      totalUsd,
    },
  };
}

function upsertEvidence(map: Map<string, CieloDiscoveredCandidate>, evidence: CandidateEvidence): void {
  const now = new Date().toISOString();
  const existing = map.get(evidence.address);
  if (!existing) {
    map.set(evidence.address, {
      address: evidence.address,
      label: evidence.label,
      trust: 0.3,
      enabled: true,
      rank: evidence.rank,
      source: evidence.source,
      notes: `Candidate only until vet-wallets passes it. Cielo score=${evidence.score}/100. ${evidence.reasons.join('; ')}`,
      cielo: {
        score: evidence.score,
        sources: [evidence.source],
        reasons: [...evidence.reasons],
        metrics: evidence.metrics,
        discoveredAt: now,
      },
    });
    return;
  }
  const sources = new Set([...existing.cielo.sources, evidence.source]);
  const combinedScore = Math.round(clamp(Math.max(existing.cielo.score, evidence.score) + Math.min(12, (sources.size - 1) * 4), 0, 100));
  existing.cielo = {
    score: combinedScore,
    sources: [...sources],
    reasons: [...new Set([...existing.cielo.reasons, ...evidence.reasons])],
    metrics: {
      ...existing.cielo.metrics,
      [`source_${sources.size}`]: evidence.metrics,
    },
    discoveredAt: existing.cielo.discoveredAt,
  };
  existing.source = existing.cielo.sources.join(' | ');
  existing.notes = `Candidate only until vet-wallets passes it. Cielo score=${existing.cielo.score}/100. Sources=${existing.cielo.sources.length}.`;
}

function summarizeVetting(results: WalletVetResult[]): Record<WalletVetDecision, number> {
  return results.reduce<Record<WalletVetDecision, number>>((acc, result) => {
    acc[result.decision] += 1;
    return acc;
  }, { keep: 0, probation: 0, reject: 0 });
}

function parseArgs(args: string[], cfg: AppConfig): CieloDiscoveryOptions {
  const getFlagValue = (name: string): string | undefined => {
    const prefix = `${name}=`;
    const inline = args.find(arg => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  const maxCandidates = Number(getFlagValue('--limit') ?? cfg.cieloMaxCandidates);
  const pages = Number(getFlagValue('--pages') ?? cfg.cieloDiscoveryPages);
  const signatureLimit = Number(getFlagValue('--signatures') ?? cfg.cieloVettingSignatureLimit);
  return {
    apply: args.includes('--apply'),
    includeProbation: args.includes('--include-probation'),
    json: args.includes('--json'),
    useApp: !args.includes('--no-app'),
    useApi: !args.includes('--no-api'),
    candidatePath: path.resolve(process.cwd(), getFlagValue('--candidates') ?? cfg.cieloCandidatePath),
    outputPath: path.resolve(process.cwd(), getFlagValue('--output') ?? cfg.cieloDiscoveryReportPath),
    vettingReportPath: path.resolve(process.cwd(), getFlagValue('--vet-report') ?? './data/cielo-wallet-vetting-report.json'),
    maxCandidates: clamp(Number.isFinite(maxCandidates) ? maxCandidates : cfg.cieloMaxCandidates, 1, 500),
    pages: clamp(Number.isFinite(pages) ? pages : cfg.cieloDiscoveryPages, 1, 10),
    signatureLimit: clamp(Number.isFinite(signatureLimit) ? signatureLimit : cfg.cieloVettingSignatureLimit, 1, 100),
  };
}

async function collectWalletDiscovery(client: CieloClient, cfg: AppConfig, options: CieloDiscoveryOptions, candidates: Map<string, CieloDiscoveredCandidate>, known: Set<string>, summary: SourceSummary[]): Promise<void> {
  for (const sort of DISCOVERY_SORTS) {
    const source: SourceSummary = { source: `wallet-discovery:${sort}`, fetched: 0, candidates: 0, skipped: 0, errors: [] };
    try {
      const rows = await client.getWalletDiscovery({ type: 'solana', sort, timeframe: '30d', pages: options.pages });
      source.fetched = rows.length;
      rows.forEach((row, idx) => {
        const evidence = scoreWalletDiscoveryRow(row, cfg, idx + 1, sort);
        if (!evidence || known.has(evidence.address)) {
          source.skipped += 1;
          return;
        }
        upsertEvidence(candidates, evidence);
        source.candidates += 1;
      });
    } catch (err) {
      source.errors.push(err instanceof Error ? err.message : String(err));
    }
    summary.push(source);
  }
}

async function collectTaggedWallets(client: CieloClient, candidates: Map<string, CieloDiscoveredCandidate>, known: Set<string>, summary: SourceSummary[]): Promise<void> {
  const source: SourceSummary = { source: 'api:wallets-by-tag', fetched: 0, candidates: 0, skipped: 0, errors: [] };
  for (const tag of API_TAGS) {
    try {
      const rows = await client.getWalletsByTag({ tags: [tag], walletType: 'solana', limit: 50 });
      source.fetched += rows.length;
      rows.forEach((row, idx) => {
        const evidence = scoreWalletLikeRow(row, `Cielo API Wallets by Tag (${tag})`, idx + 1);
        if (!evidence || known.has(evidence.address)) {
          source.skipped += 1;
          return;
        }
        upsertEvidence(candidates, evidence);
        source.candidates += 1;
      });
    } catch (err) {
      source.errors.push(`${tag}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  summary.push(source);
}

async function collectFeedWallets(client: CieloClient, params: { sourceName: string; labelPrefix: string; feedParams: Record<string, unknown> }, candidates: Map<string, CieloDiscoveredCandidate>, known: Set<string>, summary: SourceSummary[]): Promise<void> {
  const source: SourceSummary = { source: params.sourceName, fetched: 0, candidates: 0, skipped: 0, errors: [] };
  try {
    const feed = await client.getFeed(params.feedParams);
    source.fetched = feed.length;
    const byWallet = new Map<string, unknown[]>();
    for (const item of feed) {
      const wallets = extractWalletAddressesFromFeedItem(item);
      for (const wallet of wallets) {
        if (known.has(wallet)) continue;
        const items = byWallet.get(wallet) ?? [];
        items.push(item);
        byWallet.set(wallet, items);
      }
    }
    for (const [wallet, items] of byWallet.entries()) {
      if (items.length < 2) {
        source.skipped += 1;
        continue;
      }
      upsertEvidence(candidates, scoreFeedWallet(wallet, items, params.sourceName, params.labelPrefix));
      source.candidates += 1;
    }
  } catch (err) {
    source.errors.push(err instanceof Error ? err.message : String(err));
  }
  summary.push(source);
}

async function collectPublicListFeeds(client: CieloClient, cfg: AppConfig, options: CieloDiscoveryOptions, candidates: Map<string, CieloDiscoveredCandidate>, known: Set<string>, summary: SourceSummary[]): Promise<void> {
  const listsSummary: SourceSummary = { source: 'app:public-lists', fetched: 0, candidates: 0, skipped: 0, errors: [] };
  let lists: unknown[] = [];
  try {
    lists = await client.getPublicLists({ order: 'popular', size: 50, pages: 1 });
    listsSummary.fetched = lists.length;
  } catch (err) {
    listsSummary.errors.push(err instanceof Error ? err.message : String(err));
  }
  summary.push(listsSummary);
  const selected = lists.filter(shouldInspectPublicList).slice(0, 5);
  listsSummary.candidates = selected.length;
  listsSummary.skipped = Math.max(0, lists.length - selected.length);
  const fromTimestamp = Math.floor(Date.now() / 1000 - cfg.cieloFeedLookbackHours * 3600);
  for (const list of selected) {
    const id = listId(list);
    if (id == null) continue;
    const name = stringAt(list, ['name']) ?? `list_${id}`;
    await collectFeedWallets(client, {
      sourceName: `Cielo Public List Feed (${name})`,
      labelPrefix: `cielo_list_${id}`,
      feedParams: {
        list: id,
        chains: ['solana'],
        txTypes: ['swap'],
        limit: 100,
        minUSD: cfg.cieloFeedMinUsd,
        fromTimestamp,
      },
    }, candidates, known, summary);
  }
}

async function collectTokenFlowFeeds(client: CieloClient, cfg: AppConfig, candidates: Map<string, CieloDiscoveredCandidate>, known: Set<string>, summary: SourceSummary[]): Promise<void> {
  const tokenSet = new Set<string>();
  const tokenSummary: SourceSummary = { source: 'api/app:trending-pulse-tokens', fetched: 0, candidates: 0, skipped: 0, errors: [] };
  try {
    const trending = await client.getTrendingTokens({ chain: 'solana', interval: '1h', limit: MAX_TOKEN_FEED_TOKENS, sortBy: 'popular_desc' });
    tokenSummary.fetched += trending.length;
    trending.map(tokenAddress).filter((token): token is string => Boolean(token)).forEach(token => tokenSet.add(token));
  } catch (err) {
    tokenSummary.errors.push(`trending: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const category of ['new_pairs', 'almost_migrated', 'migrated'] as const) {
    try {
      const pulse = await client.getPulseTokens({ category, limit: 20, protocols: CIELO_PULSE_PROTOCOLS });
      tokenSummary.fetched += pulse.length;
      pulse.map(tokenAddress).filter((token): token is string => Boolean(token)).forEach(token => tokenSet.add(token));
    } catch (err) {
      tokenSummary.errors.push(`pulse ${category}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  summary.push(tokenSummary);
  const tokens = [...tokenSet].slice(0, MAX_TOKEN_FEED_TOKENS);
  tokenSummary.candidates = tokens.length;
  const fromTimestamp = Math.floor(Date.now() / 1000 - cfg.cieloFeedLookbackHours * 3600);
  for (let idx = 0; idx < tokens.length; idx += TOKEN_FEED_BATCH_SIZE) {
    const batch = tokens.slice(idx, idx + TOKEN_FEED_BATCH_SIZE);
    await collectFeedWallets(client, {
      sourceName: `Cielo Trending/Pulse Token Feed batch_${idx / TOKEN_FEED_BATCH_SIZE + 1}`,
      labelPrefix: 'cielo_token_flow',
      feedParams: {
        chains: ['solana'],
        txTypes: ['swap'],
        tokens: batch,
        limit: 100,
        minUSD: cfg.cieloFeedMinUsd,
        fromTimestamp,
      },
    }, candidates, known, summary);
  }
}

export async function discoverCieloWallets(cfg: AppConfig, options: CieloDiscoveryOptions): Promise<CieloDiscoveryResult> {
  const client = new CieloClient({
    apiKey: cfg.cieloApiKey,
    apiBaseUrl: cfg.cieloApiBaseUrl,
    appBaseUrl: cfg.cieloAppBaseUrl,
  });
  const sources: SourceSummary[] = [];
  const known = readKnownAddresses([cfg.watchedWalletsPath, options.candidatePath]);
  const candidates = new Map<string, CieloDiscoveredCandidate>();

  if (options.useApp) {
    await collectWalletDiscovery(client, cfg, options, candidates, known, sources);
  }

  if (options.useApi && client.hasApiKey()) {
    await collectTaggedWallets(client, candidates, known, sources);
    await collectPublicListFeeds(client, cfg, options, candidates, known, sources);
    await collectTokenFlowFeeds(client, cfg, candidates, known, sources);
  } else if (options.useApi) {
    sources.push({ source: 'api-backed-sources', fetched: 0, candidates: 0, skipped: 0, errors: ['CIELO_API_KEY missing; skipped official API feed/tags/trending sources'] });
  }

  const sortedCandidates = [...candidates.values()]
    .sort((a, b) => b.cielo.score - a.cielo.score || a.address.localeCompare(b.address))
    .slice(0, options.maxCandidates)
    .map(candidate => ({ ...candidate, ...normalizeWallet(candidate), cielo: candidate.cielo }));

  fs.mkdirSync(path.dirname(options.candidatePath), { recursive: true });
  fs.writeFileSync(options.candidatePath, `${JSON.stringify(sortedCandidates, null, 2)}\n`);

  const result: CieloDiscoveryResult = {
    generatedAt: new Date().toISOString(),
    candidatePath: options.candidatePath,
    outputPath: options.outputPath,
    apply: options.apply,
    apiKeyConfigured: client.hasApiKey(),
    sources,
    candidates: sortedCandidates,
  };

  if (options.apply && sortedCandidates.length > 0) {
    const rpc = new SolanaRpcClient(cfg.solanaRpcUrl);
    const vettingResults = await evaluateCandidates(rpc, sortedCandidates, options.signatureLimit);
    writeVettingReport(options.vettingReportPath, options.candidatePath, options.signatureLimit, true, options.includeProbation, vettingResults);
    const added = applyResults(cfg.watchedWalletsPath, vettingResults, options.includeProbation);
    result.vetting = {
      reportPath: options.vettingReportPath,
      added,
      counts: summarizeVetting(vettingResults),
      results: vettingResults,
    };
  }

  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  fs.writeFileSync(options.outputPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function printText(result: CieloDiscoveryResult): void {
  const fetched = result.sources.reduce((sum, source) => sum + source.fetched, 0);
  const sourceCandidates = result.sources.reduce((sum, source) => sum + source.candidates, 0);
  const errors = result.sources.flatMap(source => source.errors.map(error => `${source.source}: ${error}`));
  console.log(`cielo wallet discovery complete: candidates=${result.candidates.length} fetched=${fetched} source_hits=${sourceCandidates}`);
  console.log(`candidate file: ${result.candidatePath}`);
  console.log(`report: ${result.outputPath}`);
  console.log(`api key: ${result.apiKeyConfigured ? 'configured' : 'missing'}`);
  if (result.vetting) {
    console.log(`vetting: keep=${result.vetting.counts.keep} probation=${result.vetting.counts.probation} reject=${result.vetting.counts.reject}`);
    console.log(`applied to watchlist: added=${result.vetting.added}`);
    console.log(`vetting report: ${result.vetting.reportPath}`);
  } else {
    console.log('apply: false (candidate file only; no active watchlist changes)');
  }
  if (errors.length) {
    console.log('warnings:');
    errors.slice(0, 10).forEach(error => console.log(`  - ${error}`));
  }
  console.log('mode: dry-run wallet intelligence only; no trading execution');
  console.log('top candidates:');
  for (const candidate of result.candidates.slice(0, 10)) {
    console.log(`  ${candidate.label ?? candidate.address} ${candidate.address} score=${candidate.cielo.score}/100 sources=${candidate.cielo.sources.length}`);
  }
}

export async function runCieloWalletDiscoveryCli(args: string[], cfg = loadConfig()): Promise<CieloDiscoveryResult> {
  const options = parseArgs(args, cfg);
  const result = await discoverCieloWallets(cfg, options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printText(result);
  return result;
}

if (require.main === module) {
  runCieloWalletDiscoveryCli(process.argv.slice(2)).catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
