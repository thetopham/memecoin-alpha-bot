import fs from 'fs';
import path from 'path';
import type { ConvergenceSignal, PaperExecutionEstimate, PaperTrade, TokenScore, WalletConfig, WalletPerformance, WalletSignalAttributionRow, WalletSwapEvent } from './types';
import { buildWalletPerformance } from './walletPerformance';

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
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
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
      CREATE TABLE IF NOT EXISTS api_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        credits REAL NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_api_usage_provider_time ON api_usage(provider, created_at);
      CREATE INDEX IF NOT EXISTS idx_api_usage_time ON api_usage(created_at);
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
    this.ensurePaperTradeColumns();
  }

  private ensurePaperTradeColumns(): void {
    const rows = this.db.prepare('PRAGMA table_info(paper_trades)').all() as Array<{ name: string }>;
    const existing = new Set(rows.map(row => row.name));
    const columns = [
      { name: 'last_price_usd', sql: 'REAL' },
      { name: 'last_multiplier', sql: 'REAL' },
      { name: 'last_pnl_percent', sql: 'REAL' },
      { name: 'last_liquidity_usd', sql: 'REAL' },
      { name: 'last_checked_at', sql: 'INTEGER' },
      { name: 'observed_price_usd', sql: 'REAL' },
      { name: 'estimated_fill_price_usd', sql: 'REAL' },
      { name: 'estimated_slippage_bps', sql: 'REAL' },
      { name: 'estimated_price_impact_bps', sql: 'REAL' },
      { name: 'estimated_notional_usd', sql: 'REAL' },
      { name: 'reference_sol_usd', sql: 'REAL' },
      { name: 'comparison_notional_usd', sql: 'REAL' },
      { name: 'comparison_slippage_bps', sql: 'REAL' },
      { name: 'comparison_fill_price_usd', sql: 'REAL' },
      { name: 'effective_liquidity_usd', sql: 'REAL' },
      { name: 'liquidity_basis', sql: 'TEXT' },
      { name: 'liquidity_confidence', sql: 'TEXT' },
      { name: 'fill_model', sql: 'TEXT' },
      { name: 'fill_source', sql: 'TEXT' },
      { name: 'signal_first_seen_at', sql: 'INTEGER' },
      { name: 'signal_last_seen_at', sql: 'INTEGER' },
      { name: 'signal_created_at', sql: 'INTEGER' },
      { name: 'first_wallet_to_fill_seconds', sql: 'INTEGER' },
      { name: 'latest_wallet_to_fill_seconds', sql: 'INTEGER' },
      { name: 'signal_to_fill_seconds', sql: 'INTEGER' },
    ];
    for (const column of columns) {
      if (!existing.has(column.name)) {
        this.db.exec(`ALTER TABLE paper_trades ADD COLUMN ${column.name} ${column.sql}`);
      }
    }
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

  recordApiUsage(input: { provider: string; endpoint: string; credits?: number; status?: string; createdAt?: number }): void {
    this.db.prepare(`
      INSERT INTO api_usage(provider, endpoint, credits, status, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      input.provider,
      input.endpoint,
      Math.max(0, input.credits ?? 1),
      input.status ?? 'ok',
      input.createdAt ?? Math.floor(Date.now() / 1000),
    );
  }

  apiUsageSince(provider: string, sinceSeconds: number): { requests: number; credits: number } {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS requests, COALESCE(SUM(credits), 0) AS credits
      FROM api_usage
      WHERE provider = ? AND created_at >= ?
    `).get(provider, sinceSeconds) as { requests?: number; credits?: number } | undefined;
    return { requests: Number(row?.requests ?? 0), credits: Number(row?.credits ?? 0) };
  }

  apiUsageByProviderSince(sinceSeconds: number): Array<{ provider: string; requests: number; credits: number }> {
    const rows = this.db.prepare(`
      SELECT provider, COUNT(*) AS requests, COALESCE(SUM(credits), 0) AS credits
      FROM api_usage
      WHERE created_at >= ?
      GROUP BY provider
      ORDER BY credits DESC, requests DESC
    `).all(sinceSeconds) as Array<{ provider: string; requests: number; credits: number }>;
    return rows.map(row => ({ provider: row.provider, requests: Number(row.requests), credits: Number(row.credits) }));
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

  openPaperTrade(
    tokenAddress: string,
    symbol: string,
    entryPriceUsd: number,
    entrySol: number,
    signalId: number,
    now: number,
    execution?: PaperExecutionEstimate,
  ): number {
    const existing = this.getOpenTrade(tokenAddress);
    if (existing) return existing.id;
    const result = this.db.prepare(`
      INSERT INTO paper_trades(
        token_address, symbol, entry_price_usd, entry_sol, entry_time, status, max_multiplier, remaining_percent, signal_id,
        observed_price_usd, estimated_fill_price_usd, estimated_slippage_bps, estimated_price_impact_bps,
        estimated_notional_usd, reference_sol_usd, comparison_notional_usd, comparison_slippage_bps, comparison_fill_price_usd,
        effective_liquidity_usd, liquidity_basis, liquidity_confidence, fill_model, fill_source,
        signal_first_seen_at, signal_last_seen_at, signal_created_at, first_wallet_to_fill_seconds, latest_wallet_to_fill_seconds, signal_to_fill_seconds
      )
      VALUES (?, ?, ?, ?, ?, 'open', 1, 100, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tokenAddress,
      symbol,
      entryPriceUsd,
      entrySol,
      now,
      signalId,
      execution?.observedPriceUsd ?? null,
      execution?.estimatedFillPriceUsd ?? null,
      execution?.estimatedSlippageBps ?? null,
      execution?.estimatedPriceImpactBps ?? null,
      execution?.notionalUsd ?? null,
      execution?.referenceSolUsd ?? null,
      execution?.comparisonNotionalUsd ?? null,
      execution?.comparisonSlippageBps ?? null,
      execution?.comparisonFillPriceUsd ?? null,
      execution?.effectiveLiquidityUsd ?? null,
      execution?.liquidityBasis ?? null,
      execution?.liquidityConfidence ?? null,
      execution?.fillModel ?? null,
      execution?.fillSource ?? null,
      execution?.signalFirstSeenAt ?? null,
      execution?.signalLastSeenAt ?? null,
      execution?.signalCreatedAt ?? null,
      execution?.firstWalletToFillSeconds ?? null,
      execution?.latestWalletToFillSeconds ?? null,
      execution?.signalToFillSeconds ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  updateOpenTrade(
    tokenAddress: string,
    maxMultiplier: number,
    remainingPercent: number,
    market?: { priceUsd: number; multiplier: number; pnlPercent: number; liquidityUsd: number; checkedAt: number }
  ): void {
    if (!market) {
      this.db.prepare(`
        UPDATE paper_trades SET max_multiplier = MAX(max_multiplier, ?), remaining_percent = ?
        WHERE token_address = ? AND status = 'open'
      `).run(maxMultiplier, remainingPercent, tokenAddress);
      return;
    }

    this.db.prepare(`
      UPDATE paper_trades
      SET max_multiplier = MAX(max_multiplier, ?),
          remaining_percent = ?,
          last_price_usd = ?,
          last_multiplier = ?,
          last_pnl_percent = ?,
          last_liquidity_usd = ?,
          last_checked_at = ?
      WHERE token_address = ? AND status = 'open'
    `).run(
      maxMultiplier,
      remainingPercent,
      market.priceUsd,
      market.multiplier,
      market.pnlPercent,
      market.liquidityUsd,
      market.checkedAt,
      tokenAddress
    );
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

  closedTrades(limit?: number): PaperTrade[] {
    const sql = limit == null
      ? 'SELECT * FROM paper_trades WHERE status = ? ORDER BY exit_time DESC, id DESC'
      : 'SELECT * FROM paper_trades WHERE status = ? ORDER BY exit_time DESC, id DESC LIMIT ?';
    const rows = limit == null
      ? this.db.prepare(sql).all('closed') as any[]
      : this.db.prepare(sql).all('closed', limit) as any[];
    return rows.map(rowToPaperTrade);
  }

  walletSignalAttributionRows(): WalletSignalAttributionRow[] {
    const rows = this.db.prepare(`
      SELECT
        s.id AS signal_id,
        s.token_address AS token_address,
        s.symbol AS symbol,
        s.pass AS pass,
        s.composite_score AS composite_score,
        s.wallets_json AS wallets_json,
        s.created_at AS created_at,
        p.id AS trade_id,
        p.status AS trade_status,
        p.entry_sol AS entry_sol,
        p.remaining_percent AS remaining_percent,
        p.pnl_percent AS pnl_percent,
        p.last_pnl_percent AS last_pnl_percent,
        p.estimated_slippage_bps AS estimated_slippage_bps,
        p.latest_wallet_to_fill_seconds AS latest_wallet_to_fill_seconds,
        p.signal_to_fill_seconds AS signal_to_fill_seconds,
        p.exit_time AS exit_time
      FROM signals s
      LEFT JOIN paper_trades p ON p.signal_id = s.id
      ORDER BY s.id ASC
    `).all() as any[];
    return rows.map(rowToWalletSignalAttribution);
  }

  walletPerformance(wallets: WalletConfig[], limit = 10): WalletPerformance[] {
    return buildWalletPerformance(this.walletSignalAttributionRows(), wallets, { limit });
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

function rowToWalletSignalAttribution(row: any): WalletSignalAttributionRow {
  return {
    signalId: Number(row.signal_id),
    tokenAddress: row.token_address,
    symbol: row.symbol,
    pass: Boolean(row.pass),
    compositeScore: Number(row.composite_score),
    walletsJson: row.wallets_json,
    createdAt: Number(row.created_at),
    tradeId: row.trade_id == null ? null : Number(row.trade_id),
    tradeStatus: row.trade_status ?? null,
    entrySol: row.entry_sol == null ? null : Number(row.entry_sol),
    remainingPercent: row.remaining_percent == null ? null : Number(row.remaining_percent),
    pnlPercent: row.pnl_percent == null ? null : Number(row.pnl_percent),
    lastPnlPercent: row.last_pnl_percent == null ? null : Number(row.last_pnl_percent),
    estimatedSlippageBps: row.estimated_slippage_bps == null ? null : Number(row.estimated_slippage_bps),
    latestWalletToFillSeconds: row.latest_wallet_to_fill_seconds == null ? null : Number(row.latest_wallet_to_fill_seconds),
    signalToFillSeconds: row.signal_to_fill_seconds == null ? null : Number(row.signal_to_fill_seconds),
    exitTime: row.exit_time == null ? null : Number(row.exit_time),
  };
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
    signalId: row.signal_id == null ? null : Number(row.signal_id),
    observedPriceUsd: row.observed_price_usd == null ? null : Number(row.observed_price_usd),
    estimatedFillPriceUsd: row.estimated_fill_price_usd == null ? null : Number(row.estimated_fill_price_usd),
    estimatedSlippageBps: row.estimated_slippage_bps == null ? null : Number(row.estimated_slippage_bps),
    estimatedPriceImpactBps: row.estimated_price_impact_bps == null ? null : Number(row.estimated_price_impact_bps),
    estimatedNotionalUsd: row.estimated_notional_usd == null ? null : Number(row.estimated_notional_usd),
    referenceSolUsd: row.reference_sol_usd == null ? null : Number(row.reference_sol_usd),
    comparisonNotionalUsd: row.comparison_notional_usd == null ? null : Number(row.comparison_notional_usd),
    comparisonSlippageBps: row.comparison_slippage_bps == null ? null : Number(row.comparison_slippage_bps),
    comparisonFillPriceUsd: row.comparison_fill_price_usd == null ? null : Number(row.comparison_fill_price_usd),
    effectiveLiquidityUsd: row.effective_liquidity_usd == null ? null : Number(row.effective_liquidity_usd),
    liquidityBasis: row.liquidity_basis,
    liquidityConfidence: row.liquidity_confidence,
    fillModel: row.fill_model,
    fillSource: row.fill_source,
    signalFirstSeenAt: row.signal_first_seen_at == null ? null : Number(row.signal_first_seen_at),
    signalLastSeenAt: row.signal_last_seen_at == null ? null : Number(row.signal_last_seen_at),
    signalCreatedAt: row.signal_created_at == null ? null : Number(row.signal_created_at),
    firstWalletToFillSeconds: row.first_wallet_to_fill_seconds == null ? null : Number(row.first_wallet_to_fill_seconds),
    latestWalletToFillSeconds: row.latest_wallet_to_fill_seconds == null ? null : Number(row.latest_wallet_to_fill_seconds),
    signalToFillSeconds: row.signal_to_fill_seconds == null ? null : Number(row.signal_to_fill_seconds),
    lastPriceUsd: row.last_price_usd == null ? null : Number(row.last_price_usd),
    lastMultiplier: row.last_multiplier == null ? null : Number(row.last_multiplier),
    lastPnlPercent: row.last_pnl_percent == null ? null : Number(row.last_pnl_percent),
    lastLiquidityUsd: row.last_liquidity_usd == null ? null : Number(row.last_liquidity_usd),
    lastCheckedAt: row.last_checked_at == null ? null : Number(row.last_checked_at),
    exitPriceUsd: row.exit_price_usd == null ? null : Number(row.exit_price_usd),
    exitTime: row.exit_time == null ? null : Number(row.exit_time),
    pnlPercent: row.pnl_percent == null ? null : Number(row.pnl_percent),
    exitReason: row.exit_reason,
  };
}
