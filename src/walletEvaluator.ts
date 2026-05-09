import fs from 'fs';
import path from 'path';
import { loadConfig } from './config';
import { SolanaRpcClient } from './rpc';
import { parseWalletSwap } from './transactionParser';
import { normalizeWallet } from './wallets';
import type { SwapSource, WalletConfig, WalletSwapEvent } from './types';

export type WalletVetDecision = 'keep' | 'probation' | 'reject';

export interface WalletCandidate extends WalletConfig {
  rank?: number;
  source?: string;
  notes?: string;
}

export interface WalletVetMetrics {
  signaturesChecked: number;
  parsedSwaps: number;
  buys: number;
  sells: number;
  distinctBuyTokens: number;
  distinctSellTokens: number;
  avgBuySol: number;
  medianBuySol: number;
  avgSellSol: number;
  medianSellSol: number;
  buySellSizeRatio: number | null;
  zeroishEvents: number;
  zeroishRate: number;
  latestActivityAgeHours: number | null;
  latestSwapAgeHours: number | null;
  firstSwapAgeHours: number | null;
  sampleSpanHours: number | null;
  avgHoldMinutes: number | null;
  medianHoldMinutes: number | null;
  matchedRoundTrips: number;
  roundTripTokens: number;
  profitableRoundTripTokens: number;
  losingRoundTripTokens: number;
  tokenWinRatePercent: number | null;
  avgTokenPnlPercent: number | null;
  medianTokenPnlPercent: number | null;
  largestTokenWinPercent: number | null;
  largestTokenLossPercent: number | null;
  pnlOutlierShare: number;
  activeTradingStreakDays: number;
  profitableTokenStreak: number;
  losingTokenStreak: number;
  recentSwapCount24h: number;
  recentBuyCount24h: number;
  recentSwapShare48h: number;
  sources: SwapSource[];
  parseErrors: number;
}

export interface WalletSignatureSummary {
  blockTime?: number | null;
}

export interface WalletVetResult {
  candidate: WalletCandidate;
  decision: WalletVetDecision;
  score: number;
  suggestedTrust: number;
  reasons: string[];
  metrics: WalletVetMetrics;
}

export interface VetOptions {
  candidatePath: string;
  signatureLimit: number;
  apply: boolean;
  includeProbation: boolean;
  outputPath: string;
  json: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function nullableMedian(values: number[]): number | null {
  return values.length > 0 ? median(values) : null;
}

function nullableAverage(values: number[]): number | null {
  return values.length > 0 ? average(values) : null;
}

function hoursAgo(unixSeconds: number | null, nowUnixSeconds = Date.now() / 1000): number | null {
  if (!unixSeconds) return null;
  return Math.max(0, (nowUnixSeconds - unixSeconds) / 3600);
}

interface TokenTradeSummary {
  tokenAddress: string;
  buySol: number;
  sellSol: number;
  firstBuyAt: number | null;
  lastSellAt: number | null;
}

function activeTradingStreakDays(events: WalletSwapEvent[], nowUnixSeconds: number): number {
  if (events.length === 0) return 0;
  const eventDays = new Set(events.map(event => Math.floor(event.timestamp / 86400)));
  const nowDay = Math.floor(nowUnixSeconds / 86400);
  let streak = 0;
  for (let day = nowDay; eventDays.has(day); day -= 1) {
    streak += 1;
  }
  const latestSwapAt = Math.max(...events.map(event => event.timestamp));
  return streak > 0 || nowUnixSeconds - latestSwapAt <= 24 * 3600 ? Math.max(streak, 1) : 0;
}

function tokenTradeSummaries(events: WalletSwapEvent[]): TokenTradeSummary[] {
  const byToken = new Map<string, TokenTradeSummary>();
  for (const event of events) {
    const current = byToken.get(event.tokenAddress) ?? {
      tokenAddress: event.tokenAddress,
      buySol: 0,
      sellSol: 0,
      firstBuyAt: null,
      lastSellAt: null,
    };
    if (event.direction === 'buy') {
      current.buySol += event.solAmount;
      current.firstBuyAt = current.firstBuyAt == null ? event.timestamp : Math.min(current.firstBuyAt, event.timestamp);
    } else {
      current.sellSol += event.solAmount;
      current.lastSellAt = current.lastSellAt == null ? event.timestamp : Math.max(current.lastSellAt, event.timestamp);
    }
    byToken.set(event.tokenAddress, current);
  }
  return [...byToken.values()];
}

function matchedHoldMinutes(events: WalletSwapEvent[]): number[] {
  const byToken = new Map<string, WalletSwapEvent[]>();
  for (const event of events) {
    byToken.set(event.tokenAddress, [...(byToken.get(event.tokenAddress) ?? []), event]);
  }

  const holds: number[] = [];
  for (const tokenEvents of byToken.values()) {
    const openBuys: WalletSwapEvent[] = [];
    for (const event of [...tokenEvents].sort((a, b) => a.timestamp - b.timestamp)) {
      if (event.direction === 'buy') {
        openBuys.push(event);
      } else {
        const buy = openBuys.shift();
        if (!buy) continue;
        const holdMinutes = (event.timestamp - buy.timestamp) / 60;
        if (holdMinutes >= 0) holds.push(holdMinutes);
      }
    }
  }
  return holds;
}

function currentTokenPnlStreaks(roundTrips: Array<TokenTradeSummary & { pnlSol: number }>): { profitableTokenStreak: number; losingTokenStreak: number } {
  const sorted = [...roundTrips].sort((a, b) => (b.lastSellAt ?? 0) - (a.lastSellAt ?? 0));
  let profitableTokenStreak = 0;
  for (const token of sorted) {
    if (token.pnlSol <= 0) break;
    profitableTokenStreak += 1;
  }

  let losingTokenStreak = 0;
  for (const token of sorted) {
    if (token.pnlSol >= 0) break;
    losingTokenStreak += 1;
  }

  return { profitableTokenStreak, losingTokenStreak };
}

export function calculateWalletVetMetrics(
  signatures: WalletSignatureSummary[],
  events: WalletSwapEvent[],
  parseErrors: number,
  nowUnixSeconds = Date.now() / 1000,
): WalletVetMetrics {
  const buys = events.filter(event => event.direction === 'buy');
  const sells = events.filter(event => event.direction === 'sell');
  const buyAmounts = buys.map(event => event.solAmount);
  const sellAmounts = sells.map(event => event.solAmount);
  const totalBuySol = buyAmounts.reduce((sum, value) => sum + value, 0);
  const totalSellSol = sellAmounts.reduce((sum, value) => sum + value, 0);
  const blockTimes = signatures.map(sig => sig.blockTime).filter((value): value is number => typeof value === 'number' && value > 0);
  const eventTimes = events.map(event => event.timestamp).filter(time => time > 0);
  const latestBlockTime = blockTimes.length > 0 ? Math.max(...blockTimes) : null;
  const latestSwapTime = eventTimes.length > 0 ? Math.max(...eventTimes) : null;
  const firstSwapTime = eventTimes.length > 0 ? Math.min(...eventTimes) : null;
  const zeroishEvents = events.filter(event => event.solAmount < 0.001).length;
  const holds = matchedHoldMinutes(events);
  const roundTrips = tokenTradeSummaries(events)
    .filter(token => token.buySol > 0 && token.sellSol > 0)
    .map(token => ({ ...token, pnlSol: token.sellSol - token.buySol, pnlPercent: ((token.sellSol - token.buySol) / token.buySol) * 100 }));
  const pnlPercents = roundTrips.map(token => token.pnlPercent);
  const pnlSolAbs = roundTrips.map(token => Math.abs(token.pnlSol));
  const totalAbsPnlSol = pnlSolAbs.reduce((sum, value) => sum + value, 0);
  const { profitableTokenStreak, losingTokenStreak } = currentTokenPnlStreaks(roundTrips);
  const recentSwaps = events.filter(event => nowUnixSeconds - event.timestamp <= 24 * 3600);
  const recent48hSwaps = events.filter(event => nowUnixSeconds - event.timestamp <= 48 * 3600);

  return {
    signaturesChecked: signatures.length,
    parsedSwaps: events.length,
    buys: buys.length,
    sells: sells.length,
    distinctBuyTokens: new Set(buys.map(event => event.tokenAddress)).size,
    distinctSellTokens: new Set(sells.map(event => event.tokenAddress)).size,
    avgBuySol: average(buyAmounts),
    medianBuySol: median(buyAmounts),
    avgSellSol: average(sellAmounts),
    medianSellSol: median(sellAmounts),
    buySellSizeRatio: totalSellSol > 0 ? totalBuySol / totalSellSol : null,
    zeroishEvents,
    zeroishRate: events.length > 0 ? zeroishEvents / events.length : 0,
    latestActivityAgeHours: hoursAgo(latestBlockTime, nowUnixSeconds),
    latestSwapAgeHours: hoursAgo(latestSwapTime, nowUnixSeconds),
    firstSwapAgeHours: hoursAgo(firstSwapTime, nowUnixSeconds),
    sampleSpanHours: firstSwapTime != null && latestSwapTime != null ? Math.max(0, (latestSwapTime - firstSwapTime) / 3600) : null,
    avgHoldMinutes: nullableAverage(holds),
    medianHoldMinutes: nullableMedian(holds),
    matchedRoundTrips: holds.length,
    roundTripTokens: roundTrips.length,
    profitableRoundTripTokens: roundTrips.filter(token => token.pnlSol > 0).length,
    losingRoundTripTokens: roundTrips.filter(token => token.pnlSol < 0).length,
    tokenWinRatePercent: roundTrips.length > 0 ? (roundTrips.filter(token => token.pnlSol > 0).length / roundTrips.length) * 100 : null,
    avgTokenPnlPercent: nullableAverage(pnlPercents),
    medianTokenPnlPercent: nullableMedian(pnlPercents),
    largestTokenWinPercent: pnlPercents.length > 0 ? Math.max(...pnlPercents) : null,
    largestTokenLossPercent: pnlPercents.length > 0 ? Math.min(...pnlPercents) : null,
    pnlOutlierShare: totalAbsPnlSol > 0 ? Math.max(...pnlSolAbs) / totalAbsPnlSol : 0,
    activeTradingStreakDays: activeTradingStreakDays(events, nowUnixSeconds),
    profitableTokenStreak,
    losingTokenStreak,
    recentSwapCount24h: recentSwaps.length,
    recentBuyCount24h: recentSwaps.filter(event => event.direction === 'buy').length,
    recentSwapShare48h: events.length > 0 ? recent48hSwaps.length / events.length : 0,
    sources: [...new Set(events.map(event => event.source))],
    parseErrors,
  };
}

export function classifyWallet(metrics: WalletVetMetrics): Pick<WalletVetResult, 'decision' | 'score' | 'suggestedTrust' | 'reasons'> {
  const reasons: string[] = [];
  let score = 0;

  const signatureAge = metrics.latestActivityAgeHours;
  const swapAge = metrics.latestSwapAgeHours;
  const age = swapAge ?? signatureAge;

  if (swapAge == null) {
    if (signatureAge == null) reasons.push('no recent signatures returned');
    else reasons.push(`no parsed swaps despite latest signature ${signatureAge.toFixed(1)}h ago`);
  } else if (swapAge <= 24) {
    score += 20;
  } else if (swapAge <= 72) {
    score += 15;
  } else if (swapAge <= 168) {
    score += 8;
    reasons.push(`stale: latest parsed swap ${swapAge.toFixed(1)}h ago`);
  } else {
    reasons.push(`inactive: latest parsed swap ${swapAge.toFixed(1)}h ago`);
  }

  if (signatureAge != null && swapAge != null && signatureAge <= 24 && swapAge > 168) {
    score -= 15;
    reasons.push(`latest parsed swap ${swapAge.toFixed(1)}h ago despite recent non-swap signatures`);
  }

  if (metrics.parsedSwaps >= 8) score += 12;
  else if (metrics.parsedSwaps >= 5) score += 10;
  else if (metrics.parsedSwaps >= 2) score += 5;
  else if (metrics.parsedSwaps === 0) reasons.push('no parseable Pump.fun/Raydium/Jupiter/Orca swaps in sample');
  else reasons.push('only one parseable swap in sample');

  if (metrics.buys === 0) reasons.push('no parsed buys in sample');
  score += Math.min(20, metrics.buys * 3);
  score += Math.min(20, metrics.distinctBuyTokens * 5);

  if (metrics.avgBuySol >= 1) score += 15;
  else if (metrics.avgBuySol >= 0.1) score += 10;
  else if (metrics.avgBuySol >= 0.03) score += 5;
  else if (metrics.buys > 0) reasons.push(`average buy too small at ${metrics.avgBuySol.toFixed(3)} SOL`);

  const totalDirectional = metrics.buys + metrics.sells;
  const sellRatio = totalDirectional > 0 ? metrics.sells / totalDirectional : 0;
  if (metrics.sells > 0 && sellRatio >= 0.1 && sellRatio <= 0.75) {
    score += 10;
  } else if (metrics.buys >= 3 && metrics.sells === 0) {
    reasons.push('no parsed sells in sample; exit behavior unknown');
  }

  if (metrics.sells > 0) {
    if (metrics.avgSellSol >= 1) score += 8;
    else if (metrics.avgSellSol >= 0.1) score += 6;
    else if (metrics.avgSellSol >= 0.03) score += 3;
    else reasons.push(`average sell too small at ${metrics.avgSellSol.toFixed(3)} SOL`);
  }

  const holdMinutes = metrics.avgHoldMinutes;
  const tooFastToFollow = metrics.matchedRoundTrips >= 2 && holdMinutes != null && holdMinutes < 5;
  if (tooFastToFollow && holdMinutes != null) {
    score -= 30;
    reasons.push(`average hold time ${holdMinutes.toFixed(1)}m is too fast to follow`);
  } else if (metrics.matchedRoundTrips >= 2 && holdMinutes != null && holdMinutes < 15) {
    score -= 10;
    reasons.push(`short average hold time ${holdMinutes.toFixed(1)}m; late fills likely`);
  } else if (holdMinutes != null && holdMinutes >= 15 && holdMinutes <= 24 * 60) {
    score += 8;
  }

  if (metrics.roundTripTokens >= 3) {
    if (metrics.tokenWinRatePercent != null && metrics.tokenWinRatePercent >= 55 && (metrics.medianTokenPnlPercent ?? -1) >= 0) score += 8;
    if (metrics.tokenWinRatePercent != null && metrics.tokenWinRatePercent < 35) {
      score -= 10;
      reasons.push(`weak token profit distribution: ${metrics.tokenWinRatePercent.toFixed(0)}% round-trip token win rate`);
    }
    if (metrics.pnlOutlierShare >= 0.8) {
      score -= 25;
      reasons.push(`PnL distribution dominated by one outlier token (${(metrics.pnlOutlierShare * 100).toFixed(0)}% of sampled absolute PnL)`);
    }
  }

  if (metrics.losingTokenStreak >= 3) {
    score -= 10;
    reasons.push(`recent losing streak across ${metrics.losingTokenStreak} round-trip tokens`);
  } else if (metrics.profitableTokenStreak >= 3) {
    score += 5;
  }

  if (metrics.recentBuyCount24h > 0) score += 4;
  if (metrics.activeTradingStreakDays >= 2) score += 4;
  if (metrics.parsedSwaps >= 5 && metrics.recentSwapShare48h < 0.2) {
    score -= 5;
    reasons.push('sample is mostly older swaps; current form is thin');
  }

  if (metrics.zeroishRate > 0.5) {
    score -= 20;
    reasons.push(`dust/noise: ${(metrics.zeroishRate * 100).toFixed(0)}% events below 0.001 SOL`);
  }

  if (metrics.buys >= 5 && metrics.distinctBuyTokens <= 1) {
    score -= 20;
    reasons.push('repeat buys concentrated in one token; not enough breadth');
  }

  if (metrics.sampleSpanHours != null && metrics.parsedSwaps >= 5 && metrics.sampleSpanHours < 0.5) {
    score -= 5;
    reasons.push(`thin activity window: parsed swap sample spans only ${(metrics.sampleSpanHours * 60).toFixed(0)}m`);
  }

  if (metrics.parseErrors > 5) {
    score -= 5;
    reasons.push(`${metrics.parseErrors} transaction parse errors`);
  }

  score = Math.round(clamp(score, 0, 100));

  const fresh = age != null && age <= 72;
  const activeEnoughForProbation = age != null && age <= 168;
  const holdTimeUsable = !tooFastToFollow;
  const distributionUsable = metrics.roundTripTokens < 3 || metrics.pnlOutlierShare < 0.8;
  const sellSizeUsable = metrics.sells === 0 || metrics.avgSellSol >= 0.01;
  const currentFormUsable = metrics.parsedSwaps < 5 || metrics.recentSwapShare48h >= 0.2 || (swapAge != null && swapAge <= 24);
  const keep = fresh && metrics.parsedSwaps >= 3 && metrics.buys >= 3 && metrics.distinctBuyTokens >= 2 && metrics.avgBuySol >= 0.03 && sellSizeUsable && holdTimeUsable && distributionUsable && currentFormUsable && metrics.zeroishRate <= 0.5 && score >= 65;
  const probation = !keep && activeEnoughForProbation && metrics.parsedSwaps >= 2 && metrics.buys >= 1 && metrics.distinctBuyTokens >= 1 && metrics.avgBuySol >= 0.01 && metrics.zeroishRate <= 0.75 && score >= 45;

  let decision: WalletVetDecision = 'reject';
  let suggestedTrust = 0;
  if (keep) {
    decision = 'keep';
    suggestedTrust = score >= 80 ? 0.55 : 0.5;
    if (reasons.length === 0) reasons.push('recent parsed buy activity across multiple tokens with usable hold/sell profile');
  } else if (probation) {
    decision = 'probation';
    suggestedTrust = 0.3;
    if (reasons.length === 0) reasons.push('usable but thin sample; watch manually before trusting');
  }

  return { decision, score, suggestedTrust, reasons };
}

function parseArgs(args: string[]): VetOptions {
  const getFlagValue = (name: string): string | undefined => {
    const prefix = `${name}=`;
    const inline = args.find(arg => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const candidateArg = args.find(arg => !arg.startsWith('--'));
  const signatureLimit = clamp(Number(getFlagValue('--signatures') ?? 40), 1, 100);
  const outputPath = getFlagValue('--output') ?? 'data/wallet-vetting-report.json';

  return {
    candidatePath: candidateArg ?? 'config/wallet-candidates.json',
    signatureLimit,
    apply: args.includes('--apply'),
    includeProbation: args.includes('--include-probation'),
    outputPath,
    json: args.includes('--json'),
  };
}

export function readCandidates(filePath: string): WalletCandidate[] {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as WalletCandidate[];
  if (!Array.isArray(raw)) throw new Error(`Candidate file must be a JSON array: ${filePath}`);
  return raw.map(candidate => ({ ...candidate, ...normalizeWallet(candidate) }));
}

export async function evaluateCandidate(rpc: SolanaRpcClient, candidate: WalletCandidate, signatureLimit: number): Promise<WalletVetResult> {
  let parseErrors = 0;
  const signatures = await rpc.getSignaturesForAddress(candidate.address, signatureLimit).catch(() => []);
  const events: WalletSwapEvent[] = [];

  for (const sig of signatures) {
    if (sig.err) continue;
    try {
      const tx = await rpc.getParsedTransaction(sig.signature);
      if (!tx) continue;
      const event = parseWalletSwap(
        { ...tx, signature: sig.signature, blockTime: sig.blockTime ?? tx.blockTime },
        candidate.address,
        sig.blockTime ?? Math.floor(Date.now() / 1000),
      );
      if (event) events.push(event);
    } catch {
      parseErrors += 1;
    }
  }

  const metrics = calculateWalletVetMetrics(signatures, events, parseErrors);

  return {
    candidate,
    metrics,
    ...classifyWallet(metrics),
  };
}

export function applyResults(watchedWalletsPath: string, results: WalletVetResult[], includeProbation: boolean): number {
  const current = fs.existsSync(watchedWalletsPath)
    ? JSON.parse(fs.readFileSync(watchedWalletsPath, 'utf8')) as Array<WalletCandidate & Record<string, unknown>>
    : [];
  if (!Array.isArray(current)) throw new Error(`Watched wallets config must be a JSON array: ${watchedWalletsPath}`);

  const existing = new Set(current.map(wallet => wallet.address));
  let added = 0;
  const decisions = includeProbation ? new Set<WalletVetDecision>(['keep', 'probation']) : new Set<WalletVetDecision>(['keep']);

  for (const result of results) {
    if (!decisions.has(result.decision)) continue;
    if (existing.has(result.candidate.address)) continue;
    current.push({
      address: result.candidate.address,
      label: result.candidate.label ?? (result.candidate.rank ? `dune_pumpfun_profit_rank_${result.candidate.rank}` : `candidate_${result.candidate.address.slice(0, 6)}`),
      trust: result.suggestedTrust,
      enabled: true,
      source: result.candidate.source ?? 'public wallet candidate list',
      notes: `Added by vet-wallets ${new Date().toISOString()}: decision=${result.decision}, score=${result.score}/100, buys=${result.metrics.buys}, distinct_buy_tokens=${result.metrics.distinctBuyTokens}, avg_buy_sol=${result.metrics.avgBuySol.toFixed(3)}, avg_sell_sol=${result.metrics.avgSellSol.toFixed(3)}, avg_hold_min=${result.metrics.avgHoldMinutes == null ? 'n/a' : result.metrics.avgHoldMinutes.toFixed(1)}, token_win_rate=${result.metrics.tokenWinRatePercent == null ? 'n/a' : result.metrics.tokenWinRatePercent.toFixed(0)}%.`,
    });
    existing.add(result.candidate.address);
    added += 1;
  }

  fs.mkdirSync(path.dirname(watchedWalletsPath), { recursive: true });
  fs.writeFileSync(watchedWalletsPath, `${JSON.stringify(current, null, 2)}\n`);
  return added;
}

export function printText(results: WalletVetResult[], added: number | null, outputPath: string): void {
  const counts = results.reduce<Record<WalletVetDecision, number>>((acc, result) => {
    acc[result.decision] += 1;
    return acc;
  }, { keep: 0, probation: 0, reject: 0 });

  console.log(`wallet vetting complete: keep=${counts.keep} probation=${counts.probation} reject=${counts.reject}`);
  if (added != null) console.log(`applied to watchlist: added=${added}`);
  console.log(`report: ${outputPath}`);
  console.log('');
  for (const result of results) {
    const m = result.metrics;
    const signatureAge = m.latestActivityAgeHours == null ? 'n/a' : `${m.latestActivityAgeHours.toFixed(1)}h`;
    const swapAge = m.latestSwapAgeHours == null ? 'n/a' : `${m.latestSwapAgeHours.toFixed(1)}h`;
    const hold = m.avgHoldMinutes == null ? 'n/a' : `${m.avgHoldMinutes.toFixed(1)}m`;
    const tokenWinRate = m.tokenWinRatePercent == null ? 'n/a' : `${m.tokenWinRatePercent.toFixed(0)}%`;
    const sources = m.sources.length ? m.sources.join(',') : 'none';
    console.log(`${result.decision.toUpperCase().padEnd(9)} score=${String(result.score).padStart(3)}/100 trust=${result.suggestedTrust.toFixed(2)} ${result.candidate.label ?? result.candidate.address}`);
    console.log(`  swaps=${m.parsedSwaps} buys=${m.buys} sells=${m.sells} distinct_buy_tokens=${m.distinctBuyTokens} avg_buy=${m.avgBuySol.toFixed(3)} SOL avg_sell=${m.avgSellSol.toFixed(3)} SOL sig_latest=${signatureAge} swap_latest=${swapAge} hold_avg=${hold} token_wr=${tokenWinRate} streak_days=${m.activeTradingStreakDays} sources=${sources}`);
    console.log(`  reason: ${result.reasons.join('; ')}`);
  }
}

export async function evaluateCandidates(rpc: SolanaRpcClient, candidates: WalletCandidate[], signatureLimit: number): Promise<WalletVetResult[]> {
  const results: WalletVetResult[] = [];
  for (const candidate of candidates) {
    results.push(await evaluateCandidate(rpc, candidate, signatureLimit));
  }
  return results;
}

export function writeVettingReport(outputPath: string, candidatePath: string, signatureLimit: number, apply: boolean, includeProbation: boolean, results: WalletVetResult[]): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    sourceFile: candidatePath,
    signatureLimit,
    apply,
    includeProbation,
    results,
  }, null, 2)}\n`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const candidatePath = path.resolve(process.cwd(), options.candidatePath);
  const outputPath = path.resolve(process.cwd(), options.outputPath);
  const candidates = readCandidates(candidatePath);
  const rpc = new SolanaRpcClient(cfg.solanaRpcUrl);
  const results = await evaluateCandidates(rpc, candidates, options.signatureLimit);

  writeVettingReport(outputPath, candidatePath, options.signatureLimit, options.apply, options.includeProbation, results);

  const added = options.apply ? applyResults(cfg.watchedWalletsPath, results, options.includeProbation) : null;
  if (options.json) {
    console.log(JSON.stringify({ outputPath, added, results }, null, 2));
  } else {
    printText(results, added, outputPath);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
