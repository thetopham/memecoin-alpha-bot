import fs from 'fs';
import path from 'path';
import type { ConvergenceSignal, PaperTrade, TokenScore, WalletSwapEvent } from './types';

// Node 22 built-in sqlite is experimental but avoids native npm modules on Raspberry Pi.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: any };

export class AlphaDb {
  private readonly db: any;

  constructor(private readonly dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.init();
  }

  close(): void {
    this.db.close();
  }

  private init(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wallet_events (
        tx_hash TEXT PRIMARY KEY,
        wallet TEXT NOT NULL,
        token_address TEXT NOT NULL,
        token_symbol TEXT,
        direction TEXT NOT NULL,
        sol_amount REAL NOT NULL,
        timestamp INTEGER NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wallet_events_token_time ON wallet_events(token_address, timestamp);
      CREATE INDEX IF NOT EXISTS idx_wallet_events_wallet_time ON wallet_events(wallet, timestamp);
      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        wallet_count INTEGER NOT NULL,
        weighted_trust REAL NOT NULL,
        composite_score INTEGER NOT NULL,
        pass INTEGER NOT NULL,
        wallets_json TEXT NOT NULL,
        score_json TEXT NOT NULL,
        fail_reasons TEXT NOT NULL,
        warnings TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_signals_token_time ON signals(token_address, created_at);
      CREATE TABLE IF NOT EXISTS paper_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        entry_price_usd REAL NOT NULL,
        entry_sol REAL NOT NULL,
        entry_time INTEGER NOT NULL,
        status TEXT NOT NULL,
        max_multiplier REAL NOT NULL DEFAULT 1,
        remaining_percent REAL NOT NULL DEFAULT 100,
        exit_price_usd REAL,
        exit_time INTEGER,
        pnl_percent REAL,
        exit_reason TEXT,
        signal_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_paper_trades_status ON paper_trades(status);
    `);
  }

  getState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setState(key: string, value: string, now: number): void {
    this.db.prepare(`
      INSERT INTO state(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(key, value, now);
  }

  insertEvent(event: WalletSwapEvent): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO wallet_events(tx_hash, wallet, token_address, token_symbol, direction, sol_amount, timestamp, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(event.txHash, event.wallet, event.tokenAddress, event.tokenSymbol ?? null, event.direction, event.solAmount, event.timestamp, event.source, Math.floor(Date.now() / 1000));
    return result.changes > 0;
  }

  hasRecentSignal(tokenAddress: string, sinceSeconds: number): boolean {
    const row = this.db.prepare('SELECT id FROM signals WHERE token_address = ? AND created_at >= ? LIMIT 1').get(tokenAddress, sinceSeconds);
    return Boolean(row);
  }

  insertSignal(signal: ConvergenceSignal, score: TokenScore): number {
    const result = this.db.prepare(`
      INSERT INTO signals(token_address, symbol, wallet_count, weighted_trust, composite_score, pass, wallets_json, score_json, fail_reasons, warnings, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      signal.tokenAddress,
      score.symbol,
      signal.walletCount,
      signal.weightedTrust,
      score.composite,
      score.pass ? 1 : 0,
      JSON.stringify(signal.wallets),
      JSON.stringify(score),
      score.failReasons.join('; '),
      score.warnings.join('; '),
      Math.floor(Date.now() / 1000)
    );
    return Number(result.lastInsertRowid);
  }

  getOpenTrade(tokenAddress: string): PaperTrade | null {
    const row = this.db.prepare('SELECT * FROM paper_trades WHERE token_address = ? AND status = ? ORDER BY id DESC LIMIT 1').get(tokenAddress, 'open');
    return row ? rowToPaperTrade(row) : null;
  }

  openPaperTrade(tokenAddress: string, symbol: string, entryPriceUsd: number, entrySol: number, signalId: number, now: number): number {
    const existing = this.getOpenTrade(tokenAddress);
    if (existing) return existing.id;
    const result = this.db.prepare(`
      INSERT INTO paper_trades(token_address, symbol, entry_price_usd, entry_sol, entry_time, status, max_multiplier, remaining_percent, signal_id)
      VALUES (?, ?, ?, ?, ?, 'open', 1, 100, ?)
    `).run(tokenAddress, symbol, entryPriceUsd, entrySol, now, signalId);
    return Number(result.lastInsertRowid);
  }

  updateOpenTrade(tokenAddress: string, maxMultiplier: number, remainingPercent: number): void {
    this.db.prepare(`
      UPDATE paper_trades SET max_multiplier = MAX(max_multiplier, ?), remaining_percent = ?
      WHERE token_address = ? AND status = 'open'
    `).run(maxMultiplier, remainingPercent, tokenAddress);
  }

  closeTrade(tokenAddress: string, exitPriceUsd: number, exitTime: number, pnlPercent: number, reason: string): void {
    this.db.prepare(`
      UPDATE paper_trades SET status='closed', exit_price_usd=?, exit_time=?, pnl_percent=?, exit_reason=?, remaining_percent=0
      WHERE token_address = ? AND status = 'open'
    `).run(exitPriceUsd, exitTime, pnlPercent, reason, tokenAddress);
  }

  recentSignals(limit = 10): any[] {
    return this.db.prepare('SELECT * FROM signals ORDER BY id DESC LIMIT ?').all(limit);
  }

  openTrades(): PaperTrade[] {
    const rows = this.db.prepare('SELECT * FROM paper_trades WHERE status = ? ORDER BY id DESC').all('open') as any[];
    return rows.map(rowToPaperTrade);
  }

  stats(): { signals: number; openTrades: number; closedTrades: number; avgPnlPercent: number | null; winRate: number | null } {
    const signals = (this.db.prepare('SELECT COUNT(*) AS c FROM signals').get() as any).c as number;
    const openTrades = (this.db.prepare("SELECT COUNT(*) AS c FROM paper_trades WHERE status='open'").get() as any).c as number;
    const closedTrades = (this.db.prepare("SELECT COUNT(*) AS c FROM paper_trades WHERE status='closed'").get() as any).c as number;
    const row = this.db.prepare("SELECT AVG(pnl_percent) AS avgPnl, SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) AS wins FROM paper_trades WHERE status='closed'").get() as any;
    const avgPnlPercent = row?.avgPnl == null ? null : Number(row.avgPnl);
    const winRate = closedTrades > 0 ? (Number(row?.wins ?? 0) / closedTrades) * 100 : null;
    return { signals, openTrades, closedTrades, avgPnlPercent, winRate };
  }
}

function rowToPaperTrade(row: any): PaperTrade {
  return {
    id: Number(row.id),
    tokenAddress: row.token_address,
    symbol: row.symbol,
    entryPriceUsd: Number(row.entry_price_usd),
    entrySol: Number(row.entry_sol),
    entryTime: Number(row.entry_time),
    status: row.status,
    maxMultiplier: Number(row.max_multiplier),
    remainingPercent: Number(row.remaining_percent),
    exitPriceUsd: row.exit_price_usd == null ? null : Number(row.exit_price_usd),
    exitTime: row.exit_time == null ? null : Number(row.exit_time),
    pnlPercent: row.pnl_percent == null ? null : Number(row.pnl_percent),
    exitReason: row.exit_reason,
  };
}
