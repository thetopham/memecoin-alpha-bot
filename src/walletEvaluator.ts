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
  zeroishEvents: number;
  zeroishRate: number;
  latestActivityAgeHours: number | null;
  sources: SwapSource[];
  parseErrors: number;
}

export interface WalletVetResult {
  candidate: WalletCandidate;
  decision: WalletVetDecision;
  score: number;
  suggestedTrust: number;
  reasons: string[];
  metrics: WalletVetMetrics;
}

interface VetOptions {
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

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function hoursAgo(unixSeconds: number | null): number | null {
  if (!unixSeconds) return null;
  return Math.max(0, (Date.now() / 1000 - unixSeconds) / 3600);
}

export function classifyWallet(metrics: WalletVetMetrics): Pick<WalletVetResult, 'decision' | 'score' | 'suggestedTrust' | 'reasons'> {
  const reasons: string[] = [];
  let score = 0;

  const age = metrics.latestActivityAgeHours;
  if (age == null) {
    reasons.push('no recent signatures returned');
  } else if (age <= 24) {
    score += 20;
  } else if (age <= 72) {
    score += 15;
  } else if (age <= 168) {
    score += 8;
    reasons.push(`stale: latest signature ${age.toFixed(1)}h ago`);
  } else {
    reasons.push(`inactive: latest signature ${age.toFixed(1)}h ago`);
  }

  if (metrics.parsedSwaps >= 5) score += 10;
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

  if (metrics.zeroishRate > 0.5) {
    score -= 20;
    reasons.push(`dust/noise: ${(metrics.zeroishRate * 100).toFixed(0)}% events below 0.001 SOL`);
  }

  if (metrics.buys >= 5 && metrics.distinctBuyTokens <= 1) {
    score -= 20;
    reasons.push('repeat buys concentrated in one token; not enough breadth');
  }

  if (metrics.parseErrors > 5) {
    score -= 5;
    reasons.push(`${metrics.parseErrors} transaction parse errors`);
  }

  score = Math.round(clamp(score, 0, 100));

  const fresh = age != null && age <= 72;
  const activeEnoughForProbation = age != null && age <= 168;
  const keep = fresh && metrics.parsedSwaps >= 3 && metrics.buys >= 3 && metrics.distinctBuyTokens >= 2 && metrics.avgBuySol >= 0.03 && metrics.zeroishRate <= 0.5 && score >= 65;
  const probation = !keep && activeEnoughForProbation && metrics.parsedSwaps >= 2 && metrics.buys >= 1 && metrics.distinctBuyTokens >= 1 && metrics.avgBuySol >= 0.01 && metrics.zeroishRate <= 0.75 && score >= 45;

  let decision: WalletVetDecision = 'reject';
  let suggestedTrust = 0;
  if (keep) {
    decision = 'keep';
    suggestedTrust = score >= 80 ? 0.55 : 0.5;
    if (reasons.length === 0) reasons.push('recent parsed buy activity across multiple tokens');
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

function readCandidates(filePath: string): WalletCandidate[] {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as WalletCandidate[];
  if (!Array.isArray(raw)) throw new Error(`Candidate file must be a JSON array: ${filePath}`);
  return raw.map(candidate => ({ ...candidate, ...normalizeWallet(candidate) }));
}

async function evaluateCandidate(rpc: SolanaRpcClient, candidate: WalletCandidate, signatureLimit: number): Promise<WalletVetResult> {
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

  const buys = events.filter(event => event.direction === 'buy');
  const sells = events.filter(event => event.direction === 'sell');
  const buyAmounts = buys.map(event => event.solAmount);
  const latestBlockTime = signatures.find(sig => sig.blockTime)?.blockTime ?? null;
  const zeroishEvents = events.filter(event => event.solAmount < 0.001).length;
  const metrics: WalletVetMetrics = {
    signaturesChecked: signatures.length,
    parsedSwaps: events.length,
    buys: buys.length,
    sells: sells.length,
    distinctBuyTokens: new Set(buys.map(event => event.tokenAddress)).size,
    distinctSellTokens: new Set(sells.map(event => event.tokenAddress)).size,
    avgBuySol: buyAmounts.length > 0 ? buyAmounts.reduce((sum, value) => sum + value, 0) / buyAmounts.length : 0,
    medianBuySol: median(buyAmounts),
    zeroishEvents,
    zeroishRate: events.length > 0 ? zeroishEvents / events.length : 0,
    latestActivityAgeHours: hoursAgo(latestBlockTime),
    sources: [...new Set(events.map(event => event.source))],
    parseErrors,
  };

  return {
    candidate,
    metrics,
    ...classifyWallet(metrics),
  };
}

function applyResults(watchedWalletsPath: string, results: WalletVetResult[], includeProbation: boolean): number {
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
      notes: `Added by vet-wallets ${new Date().toISOString()}: decision=${result.decision}, score=${result.score}/100, buys=${result.metrics.buys}, distinct_buy_tokens=${result.metrics.distinctBuyTokens}, avg_buy_sol=${result.metrics.avgBuySol.toFixed(3)}.`,
    });
    existing.add(result.candidate.address);
    added += 1;
  }

  fs.mkdirSync(path.dirname(watchedWalletsPath), { recursive: true });
  fs.writeFileSync(watchedWalletsPath, `${JSON.stringify(current, null, 2)}\n`);
  return added;
}

function printText(results: WalletVetResult[], added: number | null, outputPath: string): void {
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
    const age = m.latestActivityAgeHours == null ? 'n/a' : `${m.latestActivityAgeHours.toFixed(1)}h`;
    const sources = m.sources.length ? m.sources.join(',') : 'none';
    console.log(`${result.decision.toUpperCase().padEnd(9)} score=${String(result.score).padStart(3)}/100 trust=${result.suggestedTrust.toFixed(2)} ${result.candidate.label ?? result.candidate.address}`);
    console.log(`  swaps=${m.parsedSwaps} buys=${m.buys} sells=${m.sells} distinct_buy_tokens=${m.distinctBuyTokens} avg_buy=${m.avgBuySol.toFixed(3)} SOL latest=${age} sources=${sources}`);
    console.log(`  reason: ${result.reasons.join('; ')}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const candidatePath = path.resolve(process.cwd(), options.candidatePath);
  const outputPath = path.resolve(process.cwd(), options.outputPath);
  const candidates = readCandidates(candidatePath);
  const rpc = new SolanaRpcClient(cfg.solanaRpcUrl);
  const results: WalletVetResult[] = [];

  for (const candidate of candidates) {
    results.push(await evaluateCandidate(rpc, candidate, options.signatureLimit));
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    sourceFile: candidatePath,
    signatureLimit: options.signatureLimit,
    apply: options.apply,
    includeProbation: options.includeProbation,
    results,
  }, null, 2)}\n`);

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
