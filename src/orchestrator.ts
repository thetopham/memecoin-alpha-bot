import type { AppConfig, TokenScore, WalletSwapEvent } from './types';
import { AlphaDb } from './db';
import { SolanaRpcClient } from './rpc';
import { loadWallets } from './wallets';
import { PollingWalletTracker } from './walletTracker';
import { SignalDetector } from './signalDetector';
import { TokenAnalyzer } from './tokenAnalyzer';
import { Notifier } from './notifier';
import { PaperTrader } from './paperTrader';
import { formatPct, nowSeconds, shortAddress } from './utils';

export class Orchestrator {
  readonly db: AlphaDb;
  private readonly rpc: SolanaRpcClient;
  private readonly tracker: PollingWalletTracker;
  private readonly detector: SignalDetector;
  private readonly analyzer: TokenAnalyzer;
  private readonly notifier: Notifier;
  private readonly paper: PaperTrader;
  private timer: NodeJS.Timeout | null = null;
  private positionTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly cfg: AppConfig) {
    this.db = new AlphaDb(cfg.dbPath);
    this.rpc = new SolanaRpcClient(cfg.solanaRpcUrl);
    const wallets = loadWallets(cfg.watchedWalletsPath);
    this.tracker = new PollingWalletTracker(this.rpc, this.db, cfg.signatureLimit);
    this.detector = new SignalDetector({ minWallets: cfg.minWalletsForSignal, windowSeconds: cfg.signalWindowSeconds, wallets });
    this.analyzer = new TokenAnalyzer(this.rpc);
    this.notifier = new Notifier(cfg);
    this.paper = new PaperTrader(this.db, cfg, this.notifier);
  }

  async scanOnce(includeHistory = false): Promise<{ events: number; buys: number; sells: number }> {
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
    console.log(`poll: every ${this.cfg.pollIntervalSeconds}s | signatures: ${this.cfg.signatureLimit}`);
    console.log(`signal: ${this.cfg.minWalletsForSignal}+ wallets inside ${this.cfg.signalWindowSeconds}s | min score ${this.cfg.minCompositeScore}`);

    await this.scanOnce(this.cfg.processHistoricalOnFirstRun);
    this.timer = setInterval(() => {
      this.scanOnce(false).catch(err => console.error(`[Orchestrator] scan failed: ${(err as Error).message}`));
    }, this.cfg.pollIntervalSeconds * 1000);
    this.positionTimer = setInterval(() => {
      this.paper.updateOpenPositions().catch(err => console.error(`[Orchestrator] position update failed: ${(err as Error).message}`));
    }, Math.max(60, this.cfg.pollIntervalSeconds * 2) * 1000);
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
    const recentCutoff = nowSeconds() - this.cfg.signalWindowSeconds;
    if (this.db.hasRecentSignal(signal.tokenAddress, recentCutoff)) return;

    console.log(`[signal] ${signal.walletCount} wallets converged on ${signal.tokenAddress}`);
    let score: TokenScore | null = null;
    try {
      score = await this.analyzer.score(signal.tokenAddress);
    } catch (err) {
      console.warn(`[signal] scoring failed for ${signal.tokenAddress}: ${(err as Error).message}`);
      return;
    }
    if (!score) {
      console.warn(`[signal] no DexScreener pair found for ${signal.tokenAddress}`);
      return;
    }

    const passesThreshold = score.pass && score.composite >= this.cfg.minCompositeScore;
    const signalId = this.db.insertSignal(signal, { ...score, pass: passesThreshold });

    if (!passesThreshold) {
      const reasons = [...score.failReasons, score.composite < this.cfg.minCompositeScore ? `score ${score.composite} < ${this.cfg.minCompositeScore}` : ''].filter(Boolean);
      console.log(`[skip] $${score.symbol} ${score.composite}/100: ${reasons.join('; ')}`);
      return;
    }

    const tradeId = this.paper.openFromSignal(signal.tokenAddress, score, signalId);
    console.log(`[paper] opened trade ${tradeId ?? 'n/a'} $${score.symbol} score=${score.composite}/100 top10=${formatPct(score.snapshot.top10HolderPercent)}`);
    await this.notifier.signal(signal, score, this.cfg.maxPaperPositionSol, signalId);
  }

  statusText(): string {
    const wallets = loadWallets(this.cfg.watchedWalletsPath);
    const stats = this.db.stats();
    const open = this.db.openTrades();
    return [
      'Memecoin Alpha Bot status',
      `mode: DRY_RUN=${this.cfg.dryRun}`,
      `wallets: ${wallets.length}`,
      `signals: ${stats.signals}`,
      `open paper trades: ${stats.openTrades}`,
      `closed paper trades: ${stats.closedTrades}`,
      `avg paper pnl: ${stats.avgPnlPercent == null ? 'n/a' : `${stats.avgPnlPercent.toFixed(1)}%`}`,
      `win rate: ${stats.winRate == null ? 'n/a' : `${stats.winRate.toFixed(1)}%`}`,
      '',
      open.length === 0 ? 'No open paper trades.' : open.map(t => `#${t.id} $${t.symbol} ${t.remainingPercent}% open max=${t.maxMultiplier.toFixed(2)}x ${shortAddress(t.tokenAddress)}`).join('\n'),
    ].join('\n');
  }

  reportText(): string {
    const signals = this.db.recentSignals(8);
    const lines = [this.statusText(), '', 'Recent signals:'];
    if (signals.length === 0) {
      lines.push('none yet');
    } else {
      for (const s of signals) {
        lines.push(`#${s.id} $${s.symbol} score=${s.composite_score}/100 pass=${Boolean(s.pass)} wallets=${s.wallet_count} ${shortAddress(s.token_address)}`);
        const reasons = String(s.fail_reasons || '').trim();
        if (reasons) lines.push(`  reasons: ${reasons}`);
      }
    }
    return lines.join('\n');
  }
}
