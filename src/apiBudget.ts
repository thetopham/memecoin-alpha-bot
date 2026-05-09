import type { WalletTier } from './types';
import { nowSeconds } from './utils';

export type ApiBudgetMode = 'normal' | 'conserve' | 'emergency';

export interface ApiBudgetStatus {
  provider: string;
  mode: ApiBudgetMode;
  usedCredits24h: number;
  usedRequests24h: number;
  softDailyCredits: number;
  hardDailyCredits: number;
  monthlyCredits: number;
  projectedMonthlyCredits: number;
  remainingDailyCreditsToHard: number;
}

export interface ApiBudgetDecision {
  allowed: boolean;
  reason: string;
  status: ApiBudgetStatus;
}

export interface ApiBudgetManagerOptions {
  provider?: string;
  enabled?: boolean;
  monthlyCredits: number;
  softDailyCredits: number;
  hardDailyCredits: number;
}

interface ApiBudgetDb {
  apiUsageSince(provider: string, sinceSeconds: number): { requests: number; credits: number };
}

export class ApiBudgetManager {
  private readonly provider: string;
  private readonly enabled: boolean;
  private readonly monthlyCredits: number;
  private readonly softDailyCredits: number;
  private readonly hardDailyCredits: number;

  constructor(private readonly db: ApiBudgetDb, options: ApiBudgetManagerOptions) {
    this.provider = options.provider ?? 'helius';
    this.enabled = options.enabled !== false;
    this.monthlyCredits = Math.max(1, options.monthlyCredits);
    this.softDailyCredits = Math.max(1, Math.min(options.softDailyCredits, this.monthlyCredits));
    this.hardDailyCredits = Math.max(this.softDailyCredits, Math.min(options.hardDailyCredits, this.monthlyCredits));
  }

  dailyStatus(now = nowSeconds()): ApiBudgetStatus {
    const usage = this.db.apiUsageSince(this.provider, now - 86_400);
    const usedCredits24h = Math.max(0, usage.credits);
    const projectedMonthlyCredits = usedCredits24h * 30;
    const mode: ApiBudgetMode = usedCredits24h >= this.hardDailyCredits
      ? 'emergency'
      : usedCredits24h >= this.softDailyCredits
        ? 'conserve'
        : 'normal';
    return {
      provider: this.provider,
      mode: this.enabled ? mode : 'normal',
      usedCredits24h,
      usedRequests24h: Math.max(0, usage.requests),
      softDailyCredits: this.softDailyCredits,
      hardDailyCredits: this.hardDailyCredits,
      monthlyCredits: this.monthlyCredits,
      projectedMonthlyCredits,
      remainingDailyCreditsToHard: Math.max(0, this.hardDailyCredits - usedCredits24h),
    };
  }

  allowRequest(estimatedCredits = 1, now = nowSeconds()): ApiBudgetDecision {
    const status = this.dailyStatus(now);
    if (!this.enabled) return { allowed: true, reason: 'budget governor disabled', status };
    if (status.usedCredits24h + estimatedCredits > status.hardDailyCredits) {
      return { allowed: false, reason: `${status.provider} hard daily budget would be exceeded`, status };
    }
    return { allowed: true, reason: `${status.provider} budget ${status.mode}`, status };
  }

  allowTier(tier: WalletTier, estimatedCredits = 1, now = nowSeconds()): ApiBudgetDecision {
    const status = this.dailyStatus(now);
    if (!this.enabled) return { allowed: true, reason: 'budget governor disabled', status };
    if (tier === 'archive') return { allowed: false, reason: 'archive tier is not scanned', status };
    if (status.usedCredits24h + estimatedCredits > status.hardDailyCredits) {
      return { allowed: false, reason: `${status.provider} hard daily budget would be exceeded`, status };
    }
    if (status.mode === 'emergency') {
      return { allowed: false, reason: `${status.provider} emergency budget mode`, status };
    }
    if (status.mode === 'conserve' && tier === 'candidate') {
      return { allowed: false, reason: `${status.provider} conserve mode pauses candidate scans`, status };
    }
    return { allowed: true, reason: `${status.provider} budget ${status.mode}`, status };
  }
}

export function formatApiBudgetStatus(status: ApiBudgetStatus): string {
  return `${status.provider}: ${status.mode} | bot-logged 24h ${Math.round(status.usedCredits24h).toLocaleString()}/${status.hardDailyCredits.toLocaleString()} credits | bot-projected ${Math.round(status.projectedMonthlyCredits).toLocaleString()}/${status.monthlyCredits.toLocaleString()} monthly`;
}
