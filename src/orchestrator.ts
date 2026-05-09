import type { AppConfig, ConvergenceSignal, TokenScore, WalletSwapEvent } from './types';
import { AlphaDb } from './db';
import { SolanaRpcClient } from './rpc';
import { loadWallets, readWalletFile, writeWalletFile } from './wallets';
import { PollingWalletTracker } from './walletTracker';
import { SignalDetector } from './signalDetector';
import { TokenAnalyzer } from './tokenAnalyzer';
import { Notifier } from './notifier';
import { PaperTrader } from './paperTrader';
import { formatPct, nowSeconds, shortAddress } from './utils';
import { formatClosedPositions, formatOpenPositions, formatPaperPortfolioSummary, formatWalletPerformance, normalizeSignalReasonText } from './reportFormatter';
import { SignalRetryQueue } from './signalRetryQueue';
import { ApiBudgetManager, formatApiBudgetStatus } from './apiBudget';
import { applyWalletRotation, readCandidateFile, syncCandidateWallets, walletTierCounts } from './walletRotation';

export class Orchestrator {
  readonly db: AlphaDb;
  private readonly rpc: SolanaRpcClient;
  private readonly tracker: PollingWalletTracker;
  private readonly detector: SignalDetector;
  private readonly analyzer: TokenAnalyzer;
  private readonly notifier: Notifier;
  private readonly paper: PaperTrader;
  private readonly budget: ApiBudgetManager;
  private readonly retryQueue = new SignalRetryQueue();
  private timer: NodeJS.Timeout | null = null;
  private positionTimer: NodeJS.Timeout | null = null;
  private maintenanceInProgress = false;
  private running = false;
  private scanInProgress = false;
  private positionUpdateInProgress = false;

  constructor(private readonly cfg: AppConfig) {
    this.db = new AlphaDb(cfg.dbPath);
    this.budget = new ApiBudgetManager(this.db, {
      enabled: cfg.enableApiBudgetGovernor,
      monthlyCredits: cfg.heliusMonthlyCredits,
      softDailyCredits: cfg.heliusSoftDailyCredits,
      hardDailyCredits: cfg.heliusHardDailyCredits,
    });
    const rpcProvider = cfg.solanaRpcUrl.includes('helius') ? 'helius' : 'solana_rpc';
    this.rpc = new SolanaRpcClient(cfg.solanaRpcUrl, {
      timeoutMs: cfg.rpcTimeoutMs,
      maxRetries: cfg.rpcMaxRetries,
      minIntervalMs: cfg.rpcMinIntervalMs,
      onRequest: log => this.db.recordApiUsage({
        provider: rpcProvider,
        endpoint: log.method,
        credits: log.credits,
        status: log.status,
        createdAt: nowSeconds(),
      }),
      beforeRequest: () => this.budget.allowRequest(1),
    });
    const wallets = loadWallets(cfg.watchedWalletsPath);
    this.tracker = new PollingWalletTracker(this.rpc, this.db, cfg.signatureLimit, {
      maxSignaturePages: cfg.walletSignatureMaxPages,
      scanIntervalsSeconds: {
        hot: cfg.hotWalletScanIntervalSeconds,
        probation: cfg.probationWalletScanIntervalSeconds,
        candidate: cfg.candidateWalletScanIntervalSeconds,
      },
      budget: this.budget,
    });
    this.detector = new SignalDetector({ minWallets: cfg.minWalletsForSignal, windowSeconds: cfg.signalWindowSeconds, wallets });
    this.analyzer = new TokenAnalyzer(this.rpc);
    this.notifier = new Notifier(cfg);
    this.paper = new PaperTrader(this.db, cfg, this.notifier);
  }

  async scanOnce(includeHistory = false): Promise<{ events: number; buys: number; sells: number }> {
    try {
      await this.maintainWallets(false);
    } catch (err) {
      console.warn(`[wallet-maintenance] skipped before scan: ${(err as Error).message}`);
    }
    const wallets = loadWallets(this.cfg.watchedWalletsPath);
    this.detector.updateWallets(wallets);
    if (wallets.length === 0) {
      console.log('[Orchestrator] No wallets configured. Add wallets with: npm run add-wallet -- <address> <label>');
      return { events: 0, buys: 0, sells: 0 };
    }

    const events = await this.tracker.pollAll(wallets, includeHistory);
    let buys = 0;
    let sells = 0;
    for (const event of events) {
      const inserted = this.db.insertEvent(event);
      if (!inserted) continue;
      if (event.direction === 'buy') buys += 1;
      else sells += 1;
      await this.handleEvent(event);
    }
    await this.processPendingSignals();
    await this.paper.updateOpenPositions();
    return { events: buys + sells, buys, sells };
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const wallets = loadWallets(this.cfg.watchedWalletsPath);
    console.log('Memecoin Alpha Bot v0.1');
    console.log(`mode: DRY_RUN=${this.cfg.dryRun}`);
    console.log(`wallets: ${wallets.length}`);
    console.log(`db: ${this.cfg.dbPath}`);
    console.log(`poll: every ${this.cfg.pollIntervalSeconds}s | signatures: ${this.cfg.signatureLimit} | pages: ${this.cfg.walletSignatureMaxPages}`);
    console.log(`rpc: min interval ${this.cfg.rpcMinIntervalMs}ms | timeout ${this.cfg.rpcTimeoutMs}ms | retries ${this.cfg.rpcMaxRetries}`);
    console.log(`budget: ${formatApiBudgetStatus(this.budget.dailyStatus())}`);
    console.log(`wallet tiers: hot<=${this.cfg.hotWalletLimit} @${this.cfg.hotWalletScanIntervalSeconds}s | probation<=${this.cfg.probationWalletLimit} @${this.cfg.probationWalletScanIntervalSeconds}s | candidate<=${this.cfg.candidateWalletLimit} @${this.cfg.candidateWalletScanIntervalSeconds}s`);
    console.log(`signal: ${this.cfg.minWalletsForSignal}+ wallets inside ${this.cfg.signalWindowSeconds}s | min score ${this.cfg.minCompositeScore}`);

    await this.runScan('initial scan', this.cfg.processHistoricalOnFirstRun);
    this.timer = setInterval(() => {
      void this.runScan('scan', false);
    }, this.cfg.pollIntervalSeconds * 1000);
    this.positionTimer = setInterval(() => {
      void this.runPositionUpdate('position update');
    }, Math.max(60, this.cfg.pollIntervalSeconds * 2) * 1000);
  }

  private async runScan(label: string, includeHistory: boolean): Promise<void> {
    if (this.scanInProgress) {
      console.warn(`[Orchestrator] ${label} skipped: previous scan still running`);
      return;
    }
    this.scanInProgress = true;
    try {
      await this.scanOnce(includeHistory);
    } catch (err) {
      console.error(`[Orchestrator] ${label} failed: ${(err as Error).message}`);
    } finally {
      this.scanInProgress = false;
    }
  }

  private async runPositionUpdate(label: string): Promise<void> {
    if (this.positionUpdateInProgress || this.scanInProgress) {
      console.warn(`[Orchestrator] ${label} skipped: scan/position update already running`);
      return;
    }
    this.positionUpdateInProgress = true;
    try {
      await this.paper.updateOpenPositions();
    } catch (err) {
      console.error(`[Orchestrator] ${label} failed: ${(err as Error).message}`);
    } finally {
      this.positionUpdateInProgress = false;
    }
  }

  async maintainWallets(force = true): Promise<{ changes: string[]; wallets: number }> {
    if (!this.cfg.enableWalletAutoRotation && !this.cfg.enableWalletCandidateAutoAdd) {
      return { changes: [], wallets: loadWallets(this.cfg.watchedWalletsPath).length };
    }
    if (this.maintenanceInProgress) return { changes: [], wallets: loadWallets(this.cfg.watchedWalletsPath).length };
    const now = nowSeconds();
    const stateKey = 'last_wallet_maintenance';
    const last = Number(this.db.getState(stateKey) ?? 0);
    if (!force && Number.isFinite(last) && last > 0 && now - last < this.cfg.walletRotationIntervalSeconds) {
      return { changes: [], wallets: loadWallets(this.cfg.watchedWalletsPath).length };
    }

    this.maintenanceInProgress = true;
    try {
      const nowIso = new Date(now * 1000).toISOString();
      let wallets = readWalletFile(this.cfg.watchedWalletsPath);
      const changes: string[] = [];

      if (this.cfg.enableWalletCandidateAutoAdd) {
        try {
          const candidates = readCandidateFile(this.cfg.cieloCandidatePath);
          const synced = syncCandidateWallets(wallets, candidates, {
            enabled: true,
            candidateWalletLimit: this.cfg.candidateWalletLimit,
            maxAddsPerRun: this.cfg.walletCandidateAutoAddBatchLimit,
            nowIso,
          });
          wallets = synced.wallets;
          changes.push(...synced.changes);
        } catch (err) {
          console.warn(`[wallet-maintenance] candidate sync skipped: ${(err as Error).message}`);
        }
      }

      if (this.cfg.enableWalletAutoRotation) {
        const activeWallets = wallets.filter(wallet => wallet.enabled !== false && wallet.tier !== 'archive');
        const performance = this.db.walletPerformance(activeWallets, 10_000);
        const rotated = applyWalletRotation(wallets, performance, {
          enabled: true,
          hotWalletLimit: this.cfg.hotWalletLimit,
          probationWalletLimit: this.cfg.probationWalletLimit,
          candidateWalletLimit: this.cfg.candidateWalletLimit,
          nowIso,
        });
        wallets = rotated.wallets;
        changes.push(...rotated.changes);
      }

      if (changes.length > 0) {
        const backupPath = writeWalletFile(this.cfg.watchedWalletsPath, wallets);
        const backupNote = backupPath ? ` backup=${backupPath}` : '';
        console.log(`[wallet-maintenance] ${changes.length} change(s): ${changes.slice(0, 5).join('; ')}${changes.length > 5 ? '; …' : ''}${backupNote}`);
      }
      this.db.setState(stateKey, String(now), now);
      return { changes, wallets: wallets.filter(wallet => wallet.enabled !== false && wallet.tier !== 'archive').length };
    } finally {
      this.maintenanceInProgress = false;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.positionTimer) clearInterval(this.positionTimer);
    this.timer = null;
    this.positionTimer = null;
    this.running = false;
    this.db.close();
  }

  private async handleEvent(event: WalletSwapEvent): Promise<void> {
    const label = shortAddress(event.wallet);
    console.log(`[event] ${event.direction.toUpperCase()} ${event.tokenAddress.slice(0, 8)} ${event.solAmount.toFixed(3)} SOL by ${label} via ${event.source}`);
    if (event.direction === 'sell') {
      const exit = this.paper.recordTrackedSell(event.tokenAddress, event.wallet, event.timestamp);
      if (exit) await this.paper.emergencyExit(event.tokenAddress, '2+ tracked wallets sold inside exit window');
      return;
    }

    const signal = this.detector.onBuyEvent(event);
    if (!signal) return;
    const handled = await this.processSignal(signal, 'signal');
    if (!handled) this.retryQueue.add(signal, nowSeconds());
  }

  private async processPendingSignals(): Promise<void> {
    const now = nowSeconds();
    for (const item of this.retryQueue.due(now)) {
      const handled = await this.processSignal(item.signal, `retry ${item.attempt + 1}`);
      if (handled) this.retryQueue.remove(item.signal.tokenAddress);
      else this.retryQueue.markFailed(item.signal.tokenAddress, nowSeconds());
    }
  }

  private async processSignal(signal: ConvergenceSignal, label: string): Promise<boolean> {
    const recentCutoff = nowSeconds() - this.cfg.signalWindowSeconds;
    if (this.db.hasRecentSignal(signal.tokenAddress, recentCutoff)) return true;

    const prefix = label === 'signal' ? '[signal]' : `[${label}]`;
    console.log(`${prefix} ${signal.walletCount} wallets converged on ${signal.tokenAddress}`);
    let score: TokenScore | null = null;
    try {
      score = await this.analyzer.score(signal.tokenAddress);
    } catch (err) {
      console.warn(`${prefix} scoring failed for ${signal.tokenAddress}: ${(err as Error).message}`);
      return false;
    }
    if (!score) {
      console.warn(`${prefix} no market data yet for ${signal.tokenAddress}; queued for retry`);
      return false;
    }

    const passesThreshold = score.pass && score.composite >= this.cfg.minCompositeScore;
    const signalId = this.db.insertSignal(signal, { ...score, pass: passesThreshold });

    if (!passesThreshold) {
      const reasons = [...score.failReasons, score.composite < this.cfg.minCompositeScore ? `score ${score.composite} < ${this.cfg.minCompositeScore}` : ''].filter(Boolean);
      const detail = [...reasons, ...score.warnings].join('; ');
      console.log(`[skip] $${score.symbol} ${score.composite}/100: ${detail}`);
      return true;
    }

    const tradeId = this.paper.openFromSignal(signal.tokenAddress, score, signalId, signal);
    console.log(`[paper] opened trade ${tradeId ?? 'n/a'} $${score.symbol} score=${score.composite}/100 top10=${formatPct(score.snapshot.top10HolderPercent)}`);
    await this.notifier.signal(signal, score, this.cfg.maxPaperPositionSol, signalId);
    return true;
  }

  async refreshOpenPositions(): Promise<void> {
    await this.paper.updateOpenPositions();
  }

  statusText(): string {
    const wallets = loadWallets(this.cfg.watchedWalletsPath);
    const allWallets = readWalletFile(this.cfg.watchedWalletsPath);
    const tiers = walletTierCounts(allWallets);
    const budgetStatus = this.budget.dailyStatus();
    const stats = this.db.stats();
    const open = this.db.openTrades();
    const closed = this.db.closedTrades();
    const formatOptions = {
      now: nowSeconds(),
      stopLossPercent: this.cfg.stopLossPercent,
      takeProfitMultiples: this.cfg.takeProfitMultiples,
      paperTrailingStopActivationMultiple: this.cfg.paperTrailingStopActivationMultiple,
      paperTrailingStopDrawdownPercent: this.cfg.paperTrailingStopDrawdownPercent,
    };
    return [
      'Memecoin Alpha Bot status',
      `mode: DRY_RUN=${this.cfg.dryRun}`,
      `wallets: ${wallets.length}`,
      `wallet tiers: hot=${tiers.hot} probation=${tiers.probation} candidate=${tiers.candidate} archive=${tiers.archive}`,
      `api budget: ${formatApiBudgetStatus(budgetStatus)}`,
      `signals: ${stats.signals}`,
      `pending market retries: ${this.retryQueue.size()}`,
      `open paper trades: ${stats.openTrades}`,
      `closed paper trades: ${stats.closedTrades}`,
      `avg final-exit pnl: ${stats.avgPnlPercent == null ? 'n/a' : `${stats.avgPnlPercent.toFixed(1)}%`} (raw close price)`,
      `final-exit win rate: ${stats.winRate == null ? 'n/a' : `${stats.winRate.toFixed(1)}%`}`,
      '',
      formatPaperPortfolioSummary(open, closed, formatOptions),
      '',
      formatOpenPositions(open, formatOptions),
      '',
      formatClosedPositions(closed, formatOptions),
      '',
      formatWalletPerformance(this.db.walletPerformance(wallets, 8), 8),
    ].join('\n');
  }

  walletPerformanceText(limit = 12): string {
    return formatWalletPerformance(this.db.walletPerformance(loadWallets(this.cfg.watchedWalletsPath), limit), limit);
  }

  reportText(): string {
    const signals = this.db.recentSignals(8);
    const lines = [this.statusText(), '', 'Recent signals:'];
    if (signals.length === 0) {
      lines.push('none yet');
    } else {
      for (const s of signals) {
        lines.push(`#${s.id} $${s.symbol} score=${s.composite_score}/100 pass=${Boolean(s.pass)} wallets=${s.wallet_count} ${shortAddress(s.token_address)}`);
        const reasons = normalizeSignalReasonText(String(s.fail_reasons || '').trim(), s.score_json);
        const warnings = String(s.warnings || '').trim();
        if (reasons) lines.push(`  reasons: ${reasons}`);
        if (warnings) lines.push(`  warnings: ${warnings}`);
      }
    }
    return lines.join('\n');
  }
}
