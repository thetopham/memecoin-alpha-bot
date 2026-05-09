import fs from 'fs';
import path from 'path';
import type { WalletConfig, WalletPerformance, WalletTier } from './types';
import { normalizeWallet, readWalletFile, writeWalletFile } from './wallets';

export interface WalletRotationOptions {
  enabled: boolean;
  hotWalletLimit: number;
  probationWalletLimit: number;
  candidateWalletLimit: number;
  nowIso?: string;
}

export interface WalletCandidateSyncOptions {
  enabled: boolean;
  candidateWalletLimit: number;
  maxAddsPerRun?: number;
  nowIso?: string;
}

export interface WalletRotationResult {
  wallets: WalletConfig[];
  changes: string[];
}

const TIER_ORDER: Record<WalletTier, number> = {
  hot: 0,
  probation: 1,
  candidate: 2,
  archive: 3,
};

export function walletTier(wallet: WalletConfig): WalletTier {
  if (wallet.tier === 'hot' || wallet.tier === 'probation' || wallet.tier === 'candidate' || wallet.tier === 'archive') return wallet.tier;
  return 'hot';
}

export function walletTierCounts(wallets: WalletConfig[]): Record<WalletTier, number> {
  return wallets.reduce<Record<WalletTier, number>>((acc, wallet) => {
    const tier = wallet.enabled === false && walletTier(wallet) !== 'archive' ? 'archive' : walletTier(wallet);
    acc[tier] += 1;
    return acc;
  }, { hot: 0, probation: 0, candidate: 0, archive: 0 });
}

export function applyWalletRotation(wallets: WalletConfig[], performance: WalletPerformance[], options: WalletRotationOptions): WalletRotationResult {
  if (!options.enabled) return { wallets, changes: [] };
  const nowIso = options.nowIso ?? new Date().toISOString();
  const perfByAddress = new Map(performance.map(row => [row.address, row]));
  const changes: string[] = [];
  const normalized = wallets.map(wallet => normalizeWallet(wallet));

  const prepared = normalized.map(wallet => {
    const previousTier = walletTier(wallet);
    const perf = perfByAddress.get(wallet.address);
    const next: WalletConfig = { ...wallet, tier: previousTier };
    if (perf?.suggestedTrust != null && Number.isFinite(perf.suggestedTrust)) {
      next.trust = roundTrust(perf.suggestedTrust);
    }
    if (perf?.recommendation === 'disable_candidate') {
      next.enabled = false;
      next.tier = 'archive';
      next.trust = 0;
      next.archivedAt = nowIso;
      next.lastTierChangeAt = nowIso;
      next.notes = appendNote(next.notes, `Archived by wallet rotation: ${perf.reason}`);
      return { wallet: next, perf, score: -1, desiredTier: 'archive' as WalletTier };
    }
    const desiredTier = desiredTierFor(wallet, perf);
    return { wallet: next, perf, score: walletPriorityScore(wallet, perf), desiredTier };
  });

  const active = prepared
    .filter(item => item.wallet.enabled !== false && item.desiredTier !== 'archive')
    .sort((a, b) => b.score - a.score || TIER_ORDER[a.desiredTier] - TIER_ORDER[b.desiredTier] || String(a.wallet.label ?? a.wallet.address).localeCompare(String(b.wallet.label ?? b.wallet.address)));

  const assigned = new Map<string, WalletTier>();
  assignTier(active, assigned, 'hot', options.hotWalletLimit, item => item.desiredTier === 'hot');
  assignTier(active, assigned, 'probation', options.probationWalletLimit, item => item.desiredTier === 'probation' || item.desiredTier === 'hot');
  assignTier(active, assigned, 'candidate', options.candidateWalletLimit, item => item.desiredTier === 'candidate' || item.desiredTier === 'probation');

  const rotated = prepared.map(item => {
    const before = normalized.find(wallet => wallet.address === item.wallet.address) ?? item.wallet;
    const next = { ...item.wallet };
    const assignedTier = assigned.get(next.address);
    if (assignedTier) {
      next.tier = assignedTier;
      next.enabled = true;
    } else if (next.enabled !== false && item.desiredTier !== 'archive') {
      next.tier = 'archive';
      next.enabled = false;
      next.archivedAt = nowIso;
      next.notes = appendNote(next.notes, 'Archived by wallet rotation: outside configured Developer-plan wallet budget.');
    }
    if (walletTier(before) !== walletTier(next) || before.enabled !== next.enabled || before.trust !== next.trust) {
      next.lastTierChangeAt = nowIso;
      changes.push(`${short(before.address)} ${walletTier(before)} -> ${walletTier(next)} enabled=${next.enabled !== false} trust=${next.trust ?? 'n/a'}`);
    }
    return next;
  });

  return { wallets: rotated.sort(compareWalletsForFile), changes };
}

export function syncCandidateWallets(watched: WalletConfig[], candidates: WalletConfig[], options: WalletCandidateSyncOptions): WalletRotationResult {
  if (!options.enabled || options.candidateWalletLimit <= 0) return { wallets: watched, changes: [] };
  const nowIso = options.nowIso ?? new Date().toISOString();
  const current = watched.map(wallet => normalizeWallet(wallet));
  const existing = new Set(current.map(wallet => wallet.address));
  const candidateCount = current.filter(wallet => wallet.enabled !== false && walletTier(wallet) === 'candidate').length;
  let slots = Math.max(0, options.candidateWalletLimit - candidateCount);
  if (options.maxAddsPerRun != null) slots = Math.min(slots, Math.max(0, options.maxAddsPerRun));
  const changes: string[] = [];

  for (const rawCandidate of candidates) {
    if (slots <= 0) break;
    const candidate = normalizeWallet(rawCandidate);
    if (existing.has(candidate.address)) continue;
    current.push({
      ...candidate,
      enabled: true,
      tier: 'candidate',
      trust: typeof candidate.trust === 'number' ? Math.min(candidate.trust, 0.35) : 0.3,
      addedAt: candidate.addedAt ?? nowIso,
      lastTierChangeAt: nowIso,
      notes: appendNote(candidate.notes, 'Auto-added as slow-scan candidate; promote only after paper performance proves useful.'),
    });
    existing.add(candidate.address);
    slots -= 1;
    changes.push(`added candidate ${short(candidate.address)} from ${candidate.source ?? 'candidate file'}`);
  }

  return { wallets: current.sort(compareWalletsForFile), changes };
}

export function rotateWalletFile(filePath: string, performance: WalletPerformance[], options: WalletRotationOptions): WalletRotationResult {
  const result = applyWalletRotation(readWalletFile(filePath), performance, options);
  if (result.changes.length > 0) writeWalletFile(filePath, result.wallets);
  return result;
}

export function readCandidateFile(filePath: string): WalletConfig[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as WalletConfig[];
  if (!Array.isArray(raw)) throw new Error(`Candidate wallet config must be an array: ${filePath}`);
  return raw.map(normalizeWallet);
}

function assignTier(
  items: Array<{ wallet: WalletConfig; desiredTier: WalletTier; score: number }>,
  assigned: Map<string, WalletTier>,
  tier: WalletTier,
  limit: number,
  predicate: (item: { wallet: WalletConfig; desiredTier: WalletTier; score: number }) => boolean,
): void {
  if (limit <= 0) return;
  for (const item of items) {
    if (!predicate(item)) continue;
    if (assigned.has(item.wallet.address)) continue;
    if (assignedCount(assigned, tier) >= limit) return;
    assigned.set(item.wallet.address, tier);
  }
}

function assignedCount(assigned: Map<string, WalletTier>, tier: WalletTier): number {
  let count = 0;
  for (const value of assigned.values()) {
    if (value === tier) count += 1;
  }
  return count;
}

function desiredTierFor(wallet: WalletConfig, perf?: WalletPerformance): WalletTier {
  const current = walletTier(wallet);
  if (!perf) return current;
  if (perf.recommendation === 'promote') return 'hot';
  if (perf.recommendation === 'demote' || perf.recommendation === 'probation') return 'probation';
  if (perf.recommendation === 'keep' && current === 'candidate' && perf.signals > 0) return 'probation';
  return current;
}

function walletPriorityScore(wallet: WalletConfig, perf?: WalletPerformance): number {
  const current = walletTier(wallet);
  const trust = typeof wallet.trust === 'number' && Number.isFinite(wallet.trust) ? wallet.trust : 0.5;
  const tierBoost = current === 'hot' ? 8 : current === 'probation' ? 4 : current === 'candidate' ? 0 : -50;
  if (!perf) return 45 + trust * 20 + tierBoost;
  const recBoost = perf.recommendation === 'promote' ? 20 : perf.recommendation === 'keep' ? 5 : perf.recommendation === 'probation' ? -4 : perf.recommendation === 'demote' ? -12 : -100;
  const sampleBoost = Math.min(10, perf.paperTrades + perf.closedTrades * 2 + perf.passedSignals);
  return perf.alphaScore + recBoost + sampleBoost + trust * 10 + tierBoost;
}

function compareWalletsForFile(a: WalletConfig, b: WalletConfig): number {
  return TIER_ORDER[walletTier(a)] - TIER_ORDER[walletTier(b)]
    || Number(a.enabled === false) - Number(b.enabled === false)
    || String(a.label ?? a.address).localeCompare(String(b.label ?? b.address));
}

function appendNote(existing: unknown, note: string): string {
  const base = typeof existing === 'string' && existing.trim() ? existing.trim() : '';
  return base.includes(note) ? base : [base, note].filter(Boolean).join(' ');
}

function short(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function roundTrust(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}
