import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { ApiBudgetManager } from '../src/apiBudget';
import { AlphaDb } from '../src/db';

describe('ApiBudgetManager', () => {
  it('tracks Helius credits against a Developer-plan daily budget and gates lower-priority tiers first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memecoin-alpha-budget-'));
    const db = new AlphaDb(path.join(dir, 'alpha.sqlite'));
    const now = 1_778_400_000;
    const budget = new ApiBudgetManager(db, {
      monthlyCredits: 10_000_000,
      softDailyCredits: 250_000,
      hardDailyCredits: 300_000,
    });

    try {
      db.recordApiUsage({ provider: 'helius', endpoint: 'getSignaturesForAddress', credits: 240_000, status: 'ok', createdAt: now - 60 });
      expect(budget.dailyStatus(now).mode).toBe('normal');
      expect(budget.allowTier('candidate', 1, now).allowed).toBe(true);

      db.recordApiUsage({ provider: 'helius', endpoint: 'getTransaction', credits: 20_000, status: 'ok', createdAt: now });
      expect(budget.dailyStatus(now).mode).toBe('conserve');
      expect(budget.allowTier('hot', 1, now).allowed).toBe(true);
      expect(budget.allowTier('candidate', 1, now).allowed).toBe(false);

      db.recordApiUsage({ provider: 'helius', endpoint: 'getTransaction', credits: 45_000, status: 'ok', createdAt: now });
      expect(budget.dailyStatus(now).mode).toBe('emergency');
      expect(budget.allowTier('hot', 1, now).allowed).toBe(false);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
