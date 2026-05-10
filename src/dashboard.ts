import * as http from 'http';
import type { AddressInfo } from 'net';
import type { AppConfig, PaperTrade, WalletPerformance } from './types';
import { AlphaDb } from './db';
import { loadWallets } from './wallets';
import { estimateTradePnlPercent, estimateTradePnlSol, formatClosedPositions, formatExitRules, formatOpenPositions, formatPaperPortfolioSummary, formatWalletPerformance, normalizeSignalReasonText } from './reportFormatter';
import type { OpenPositionFormatOptions } from './reportFormatter';
import { nowSeconds, shortAddress } from './utils';

export interface DashboardOpsCron {
  name: string;
  jobId: string;
  schedule: string;
  script: string;
  purpose: string;
  behavior: string;
  tone: 'positive' | 'warning' | 'purple' | 'info';
}

export interface DashboardPaperTrade extends PaperTrade {
  positionPnlSol?: number | null;
  positionPnlPercent?: number | null;
}

export interface DashboardViewModel {
  generatedAt: number;
  dryRun: boolean;
  wallets: number;
  signals: number;
  openTrades: number;
  closedTrades: number;
  pendingMarketRetries: number;
  avgPnlPercent: number | null;
  winRate: number | null;
  portfolioText: string;
  openPositions: DashboardPaperTrade[];
  closedPositions: DashboardPaperTrade[];
  openPositionsText: string;
  closedPositionsText: string;
  walletPerformance: WalletPerformance[];
  walletPerformanceText: string;
  recentSignals: string[];
  paperExitRulesText: string;
  opsCrons: DashboardOpsCron[];
  dataSourceNote: string;
  refreshSeconds: number;
}

export interface DashboardServerOptions {
  host?: string;
  port?: number;
  refreshSeconds?: number;
  authToken?: string;
}

const DASHBOARD_DATA_SOURCE_NOTE = 'API-neutral: this dashboard reads local SQLite/watchlist state only. It does not call Helius, Cielo, DexScreener, pump.fun, or Solana RPC; live API work stays in the bot service or explicit --refresh commands.';

const HERMES_OPS_CRONS: DashboardOpsCron[] = [
  {
    name: 'Bot Health Watchdog',
    jobId: '2b59421d3551',
    schedule: 'every 10m',
    script: '~/.hermes/scripts/memecoin_bot_health_watchdog.py',
    purpose: 'service/auth/API-budget/log watchdog',
    behavior: 'silent-on-ok; alerts only when bot, dashboard, DB, auth, logs, disk, or budget look wrong',
    tone: 'positive',
  },
  {
    name: 'Position Manager',
    jobId: 'f7822adb2503',
    schedule: 'every 20m',
    script: '~/.hermes/scripts/memecoin_position_manager.py',
    purpose: 'paper open-position stale / near-stop / dormant checks',
    behavior: 'cooldown-based alerts; no live exits, no swaps, no private-key path',
    tone: 'warning',
  },
  {
    name: 'Wallet Scanner / Maintainer',
    jobId: 'bd525bf8d155',
    schedule: '17 */6 * * *',
    script: '~/.hermes/scripts/memecoin_wallet_scanner.py',
    purpose: 'Cielo discovery plus wallet candidate add/rotation maintenance',
    behavior: 'bounded candidate adds, atomic watchlist backups, reports each run because it can mutate config',
    tone: 'purple',
  },
];

export function buildDashboardViewModel(
  cfg: AppConfig,
  db: AlphaDb,
  options: Required<Pick<DashboardServerOptions, 'refreshSeconds'>>,
): DashboardViewModel {
  const wallets = loadWallets(cfg.watchedWalletsPath);
  const stats = db.stats();
  const open = db.openTrades();
  const closed = db.closedTrades();
  const formatOptions: OpenPositionFormatOptions = {
    now: nowSeconds(),
    stopLossPercent: cfg.stopLossPercent,
    takeProfitMultiples: cfg.takeProfitMultiples,
    paperTrailingStopActivationMultiple: cfg.paperTrailingStopActivationMultiple,
    paperTrailingStopDrawdownPercent: cfg.paperTrailingStopDrawdownPercent,
  };

  const walletPerformance = db.walletPerformance(wallets, 8);
  const openPositions = withPositionPnl(open, formatOptions);
  const closedPositions = withPositionPnl(closed, formatOptions);

  return {
    generatedAt: formatOptions.now,
    dryRun: cfg.dryRun,
    wallets: wallets.length,
    signals: stats.signals,
    openTrades: stats.openTrades,
    closedTrades: stats.closedTrades,
    pendingMarketRetries: 0,
    avgPnlPercent: stats.avgPnlPercent,
    winRate: stats.winRate,
    portfolioText: formatPaperPortfolioSummary(open, closed, formatOptions),
    openPositions,
    closedPositions,
    openPositionsText: formatOpenPositions(open, formatOptions),
    closedPositionsText: formatClosedPositions(closed, formatOptions),
    walletPerformance,
    walletPerformanceText: formatWalletPerformance(walletPerformance, 8),
    recentSignals: formatRecentSignals(db.recentSignals(10)),
    paperExitRulesText: formatExitRules(formatOptions),
    opsCrons: HERMES_OPS_CRONS,
    dataSourceNote: DASHBOARD_DATA_SOURCE_NOTE,
    refreshSeconds: options.refreshSeconds,
  };
}

function withPositionPnl(trades: PaperTrade[], options: OpenPositionFormatOptions): DashboardPaperTrade[] {
  return trades.map(trade => ({
    ...trade,
    positionPnlSol: estimateTradePnlSol(trade, options),
    positionPnlPercent: estimateTradePnlPercent(trade, options),
  }));
}

export async function startDashboardServer(cfg: AppConfig, options: DashboardServerOptions = {}): Promise<http.Server> {
  const host = options.host ?? process.env.DASHBOARD_HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.DASHBOARD_PORT ?? 8788);
  const refreshSeconds = Math.max(5, options.refreshSeconds ?? Number(process.env.DASHBOARD_REFRESH_SECONDS ?? 15));
  const authToken = options.authToken ?? cfg.dashboardAuthToken ?? process.env.DASHBOARD_AUTH_TOKEN?.trim();
  const allowInsecure = ['1', 'true', 'yes', 'on'].includes(String(process.env.DASHBOARD_INSECURE ?? '').toLowerCase());
  if (!authToken && !allowInsecure && !isLoopbackHost(host)) {
    throw new Error('Dashboard refuses non-loopback bind without DASHBOARD_AUTH_TOKEN. Set token or bind to 127.0.0.1.');
  }
  const db = new AlphaDb(cfg.dbPath);

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (authToken && !isDashboardRequestAuthorized(req, authToken)) {
        send(res, 401, 'text/plain; charset=utf-8', 'dashboard auth required');
        return;
      }
      if (url.pathname === '/api/dashboard') {
        const model = buildDashboardViewModel(cfg, db, { refreshSeconds });
        send(res, 200, 'application/json; charset=utf-8', JSON.stringify(model, null, 2));
        return;
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const model = buildDashboardViewModel(cfg, db, { refreshSeconds });
        send(res, 200, 'text/html; charset=utf-8', renderDashboardPage(model));
        return;
      }
      send(res, 404, 'text/plain; charset=utf-8', 'not found');
    } catch (err) {
      send(res, 500, 'text/plain; charset=utf-8', err instanceof Error ? err.message : String(err));
    }
  });

  server.on('close', () => db.close());

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const address = server.address() as AddressInfo;
      console.log(`Memecoin Alpha Dashboard listening on http://${address.address}:${address.port}`);
      console.log(`mode: PAPER / DRY RUN | read-only dashboard | auth=${authToken ? 'required' : 'disabled'} | no private keys | no swaps`);
      resolve(server);
    });
  });
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '[::1]';
}

function isDashboardRequestAuthorized(req: http.IncomingMessage, authToken: string): boolean {
  const header = req.headers['x-dashboard-token'];
  if (Array.isArray(header)) return header.includes(authToken);
  return header === authToken;
}

export function renderDashboardPage(model: DashboardViewModel): string {
  const generated = new Date(model.generatedAt * 1000).toLocaleString();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta http-equiv="refresh" content="${model.refreshSeconds}">
  <title>Memecoin Alpha Dashboard</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #070812;
      --bg2: #0b1020;
      --panel: rgba(17, 24, 39, 0.86);
      --panel-strong: rgba(20, 28, 45, 0.96);
      --card: rgba(15, 23, 42, 0.88);
      --text: #f4f7fb;
      --muted: #9aa7bd;
      --faint: #667085;
      --purple: #7132f5;
      --purple2: #8b5cf6;
      --blue: #38bdf8;
      --green: #22c55e;
      --red: #fb7185;
      --yellow: #facc15;
      --orange: #fb923c;
      --border: rgba(148, 163, 184, 0.16);
      --shadow: 0 24px 80px rgba(0, 0, 0, 0.42);
    }
    * { box-sizing: border-box; }
    html { min-height: 100%; background: var(--bg); }
    body {
      margin: 0;
      min-height: 100%;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at 15% -10%, rgba(113, 50, 245, 0.42), transparent 32%),
        radial-gradient(circle at 90% 5%, rgba(56, 189, 248, 0.18), transparent 30%),
        linear-gradient(135deg, #070812 0%, #0b1020 48%, #090b12 100%);
      color: var(--text);
    }
    a { color: inherit; }
    .dashboard-shell { max-width: 1240px; margin: 0 auto; padding: 18px; }
    .hero-card {
      position: relative;
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 28px;
      padding: 22px;
      background: linear-gradient(135deg, rgba(113, 50, 245, 0.28), rgba(15, 23, 42, 0.92) 46%, rgba(20, 28, 45, 0.95));
      box-shadow: var(--shadow);
    }
    .hero-card::after {
      content: "";
      position: absolute;
      inset: auto -18% -52% 38%;
      height: 260px;
      border-radius: 999px;
      background: radial-gradient(circle, rgba(139, 92, 246, 0.34), transparent 68%);
      pointer-events: none;
    }
    .hero-top, .section-head, .trade-head, .wallet-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
    .eyebrow { color: #c4b5fd; font-size: 12px; text-transform: uppercase; letter-spacing: 0.13em; font-weight: 800; }
    h1 { margin: 8px 0 8px; font-size: clamp(28px, 7vw, 58px); line-height: 0.94; letter-spacing: -0.06em; }
    h2 { margin: 0; font-size: clamp(21px, 4vw, 30px); letter-spacing: -0.035em; }
    h3 { margin: 0; font-size: 19px; letter-spacing: -0.025em; }
    .sub { color: var(--muted); max-width: 680px; line-height: 1.45; }
    .status-pill, .chip, .recommendation, .signal-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      padding: 7px 10px;
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.055);
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      white-space: nowrap;
    }
    .status-pill { color: #bbf7d0; border-color: rgba(34, 197, 94, 0.35); background: rgba(34, 197, 94, 0.12); }
    .hero-metrics, .metric-grid { display: grid; gap: 12px; }
    .hero-metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-top: 20px; }
    .metric-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 14px 0 0; }
    .metric-card, .mini-card {
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 14px;
      background: rgba(7, 12, 24, 0.54);
      backdrop-filter: blur(10px);
    }
    .metric-label, .mini-label, .stat-label { color: var(--muted); font-size: 11px; line-height: 1.1; text-transform: uppercase; letter-spacing: 0.09em; font-weight: 800; }
    .metric-value { margin-top: 8px; font-size: clamp(23px, 5vw, 38px); line-height: 0.96; font-weight: 900; letter-spacing: -0.055em; }
    .mini-value, .stat-value { margin-top: 5px; color: var(--text); font-size: 15px; font-weight: 800; line-height: 1.25; }
    .positive { color: var(--green); } .negative { color: var(--red); } .warning { color: var(--yellow); } .info { color: var(--blue); } .purple { color: #c4b5fd; }
    .section {
      margin-top: 18px;
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 18px;
      background: linear-gradient(180deg, rgba(15, 23, 42, 0.78), rgba(10, 15, 28, 0.82));
      box-shadow: 0 16px 60px rgba(0, 0, 0, 0.24);
      overflow: hidden;
    }
    .section-caption { color: var(--muted); margin-top: 5px; font-size: 13px; line-height: 1.35; }
    .portfolio-strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
    .portfolio-note { margin-top: 12px; color: var(--muted); font-size: 13px; line-height: 1.45; }
    .trade-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 14px; }
    .trade-card, .wallet-card, .signal-card {
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 15px;
      background: linear-gradient(180deg, rgba(20, 28, 45, 0.92), rgba(9, 13, 25, 0.9));
      min-width: 0;
    }
    .trade-card.open { border-color: rgba(56, 189, 248, 0.22); }
    .trade-card.closed { border-color: rgba(148, 163, 184, 0.18); opacity: 0.96; }
    .token-title { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
    .token-symbol { font-size: 23px; font-weight: 950; letter-spacing: -0.05em; }
    .token-id { color: var(--faint); font-size: 12px; font-weight: 800; }
    .pnl-badge { border-radius: 12px; padding: 8px 10px; font-weight: 950; font-size: 15px; background: rgba(255,255,255,0.06); }
    .stat-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 14px; }
    .stat { border: 1px solid rgba(148, 163, 184, 0.12); border-radius: 14px; padding: 10px; background: rgba(255,255,255,0.035); min-width: 0; }
    .bar { height: 8px; margin-top: 12px; border-radius: 999px; background: rgba(148,163,184,0.18); overflow: hidden; }
    .bar > span { display:block; height:100%; width: var(--w); border-radius: inherit; background: linear-gradient(90deg, var(--purple), var(--blue)); }
    .bar.negative > span { background: linear-gradient(90deg, var(--orange), var(--red)); }
    .exec-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
    .exec-item { border-radius: 14px; padding: 9px; background: rgba(113, 50, 245, 0.095); border: 1px solid rgba(113, 50, 245, 0.18); min-width: 0; }
    .exec-label { color: #c4b5fd; font-size: 10px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.08em; }
    .exec-value { margin-top: 4px; font-weight: 850; font-size: 13px; line-height: 1.22; overflow-wrap: anywhere; }
    details { margin-top: 12px; border-top: 1px solid rgba(148,163,184,0.12); padding-top: 10px; }
    summary { cursor: pointer; color: var(--muted); font-size: 13px; font-weight: 800; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 10px 0 0; color: #d7deea; font-size: 12px; line-height: 1.5; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
    .wallet-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
    .wallet-card.promote { border-color: rgba(34, 197, 94, 0.3); }
    .wallet-card.keep { border-color: rgba(56, 189, 248, 0.22); }
    .wallet-card.probation { border-color: rgba(250, 204, 21, 0.3); }
    .wallet-card.demote, .wallet-card.disable_candidate { border-color: rgba(251, 113, 133, 0.35); }
    .recommendation.promote { color: #bbf7d0; background: rgba(34,197,94,0.12); border-color: rgba(34,197,94,0.28); }
    .recommendation.keep { color: #bae6fd; background: rgba(56,189,248,0.12); border-color: rgba(56,189,248,0.26); }
    .recommendation.probation { color: #fef08a; background: rgba(250,204,21,0.12); border-color: rgba(250,204,21,0.3); }
    .recommendation.demote, .recommendation.disable_candidate { color: #fecdd3; background: rgba(251,113,133,0.13); border-color: rgba(251,113,133,0.35); }
    .alpha-line { display:flex; align-items:center; gap: 10px; margin-top: 12px; }
    .alpha-score { font-weight: 950; font-size: 28px; letter-spacing: -0.05em; }
    .alpha-bar { flex: 1; height: 10px; border-radius: 999px; background: rgba(148,163,184,0.18); overflow:hidden; }
    .alpha-bar span { display:block; height:100%; width: var(--w); border-radius: inherit; background: linear-gradient(90deg, var(--red), var(--yellow), var(--green)); }
    .wallet-stats { display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
    .wallet-reason { margin-top: 10px; color: var(--muted); font-size: 13px; line-height: 1.35; }
    .samples { display:flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
    .sample-chip { border-radius: 999px; padding: 5px 8px; font-size: 11px; color: #cbd5e1; background: rgba(255,255,255,0.055); border: 1px solid rgba(148,163,184,0.12); }
    .signal-list, .ops-grid { display:grid; gap: 10px; margin-top: 14px; }
    .ops-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .ops-card { border: 1px solid var(--border); border-radius: 18px; padding: 14px; background: rgba(255,255,255,0.04); }
    .ops-card.positive { border-color: rgba(34,197,94,0.26); }
    .ops-card.warning { border-color: rgba(250,204,21,0.28); }
    .ops-card.purple { border-color: rgba(139,92,246,0.28); }
    .ops-meta { margin-top: 10px; display: grid; gap: 7px; color: var(--muted); font-size: 12px; line-height: 1.35; }
    .signal-card { padding: 12px; }
    .signal-main { display:flex; justify-content: space-between; gap: 10px; align-items:flex-start; font-weight: 850; line-height: 1.35; }
    .signal-meta { color: var(--muted); margin-top: 6px; font-size: 13px; line-height: 1.35; }
    .empty-state { margin-top: 14px; padding: 18px; border-radius: 18px; color: var(--muted); background: rgba(255,255,255,0.04); border: 1px dashed var(--border); }
    .footer { color: var(--muted); font-size: 13px; margin: 18px 2px 0; line-height: 1.45; }
    @media (max-width: 920px) {
      .dashboard-shell { padding: 14px; }
      .hero-metrics, .metric-grid, .portfolio-strip { grid-template-columns: repeat(2, minmax(0,1fr)); }
      .trade-grid, .wallet-grid, .ops-grid { grid-template-columns: 1fr; }
      .exec-strip { grid-template-columns: repeat(2, minmax(0,1fr)); }
    }
    @media (max-width: 560px) {
      .dashboard-shell { padding: 10px; }
      .hero-card, .section { border-radius: 20px; padding: 14px; }
      .hero-top, .section-head, .trade-head, .wallet-head { flex-direction: column; align-items: stretch; }
      .hero-metrics, .metric-grid, .portfolio-strip, .stat-grid, .exec-strip, .wallet-stats { grid-template-columns: repeat(2, minmax(0,1fr)); gap: 8px; }
      .metric-card, .mini-card, .trade-card, .wallet-card { padding: 12px; border-radius: 16px; }
      .metric-value { font-size: 28px; }
      .token-symbol { font-size: 21px; }
      .status-pill, .chip, .recommendation { width: fit-content; }
    }
  </style>
</head>
<body>
  <main class="dashboard-shell">
    <section class="hero-card">
      <div class="hero-top">
        <div>
          <div class="eyebrow">Solana wallet-convergence paper trader</div>
          <h1>Memecoin Alpha Dashboard</h1>
          <div class="sub">Updated ${escapeHtml(generated)} · refreshes every ${model.refreshSeconds}s · card view replaces raw terminal text for mobile scanning.</div>
        </div>
        <div class="status-pill">${model.dryRun ? 'PAPER / DRY RUN' : 'LIVE MODE DISABLED'}</div>
      </div>
      <div class="hero-metrics">
        ${metricCard('Open', String(model.openTrades), 'info')}
        ${metricCard('Closed', String(model.closedTrades), 'warning')}
        ${metricCard('Signals', String(model.signals), '')}
        ${metricCard('Boundary', 'No swaps', 'positive')}
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <div>
          <h2>Realized PnL / Portfolio</h2>
          <div class="section-caption">Simulated PnL; take-profit proceeds are inferred from the configured paper ladder.</div>
        </div>
      </div>
      ${renderPortfolioStrip(model.portfolioText)}
    </section>

    <div class="metric-grid">
      ${metricCard('Final exit win rate', model.winRate == null ? 'n/a' : `${model.winRate.toFixed(1)}%`, model.winRate == null ? '' : 'positive')}
      ${metricCard('Avg final exit PnL', model.avgPnlPercent == null ? 'n/a' : `${formatSigned(model.avgPnlPercent)}%`, sentimentClass(model.avgPnlPercent))}
      ${metricCard('Watched wallets', String(model.wallets), 'purple')}
      ${metricCard('Market retries', String(model.pendingMarketRetries), model.pendingMarketRetries > 0 ? 'warning' : '')}
    </div>

    <section class="section">
      <div class="section-head">
        <div>
          <h2>Hermes Ops Automation</h2>
          <div class="section-caption">${escapeHtml(model.dataSourceNote)}</div>
        </div>
        <span class="chip">${model.opsCrons.length} no-agent crons</span>
      </div>
      ${renderOpsCronGrid(model.opsCrons)}
    </section>

    <section class="section">
      <div class="section-head">
        <div>
          <h2>Open Trades</h2>
          <div class="section-caption">Each card surfaces PnL, liquidity, execution estimate, $100 size check, and fill latency. Exit rules: ${escapeHtml(model.paperExitRulesText)}.</div>
        </div>
        <span class="chip">${model.openPositions.length} open</span>
      </div>
      ${renderTradeGrid(model.openPositions, 'open')}
      <details><summary>Open details</summary>${pre(model.openPositionsText)}</details>
    </section>

    <section class="section">
      <div class="section-head">
        <div>
          <h2>Closed Trades</h2>
          <div class="section-caption">Recent simulated exits with final PnL and close reason.</div>
        </div>
        <span class="chip">${model.closedPositions.length} recent</span>
      </div>
      ${renderTradeGrid(model.closedPositions.slice(0, 8), 'closed')}
      <details><summary>Details</summary>${pre(model.closedPositionsText)}</details>
    </section>

    <section class="section">
      <div class="section-head">
        <div>
          <h2>Wallet Alpha Scoreboard</h2>
          <div class="section-caption">Attribution by participating signal wallet. Use recommendations to promote, probation, or demote after enough paper outcomes.</div>
        </div>
        <span class="chip">${model.walletPerformance.length} ranked</span>
      </div>
      ${renderWalletGrid(model.walletPerformance)}
      <details><summary>Details</summary>${pre(model.walletPerformanceText)}</details>
    </section>

    <section class="section">
      <div class="section-head">
        <div>
          <h2>Recent Signals</h2>
          <div class="section-caption">Latest pass/fail reasons and pre-graduation liquidity warnings.</div>
        </div>
      </div>
      ${renderSignalCards(model.recentSignals)}
    </section>

    <div class="footer">Read-only dashboard. DRY_RUN=true, no private key, no live swap execution path.</div>
  </main>
</body>
</html>`;
}

function renderPortfolioStrip(text: string): string {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const note = lines.find(line => line.toLowerCase().startsWith('note:'));
  const cards = lines
    .filter(line => line.includes(':') && !line.toLowerCase().startsWith('paper pnl summary') && !line.toLowerCase().startsWith('note:'))
    .slice(0, 3)
    .map(line => {
      const idx = line.indexOf(':');
      const label = line.slice(0, idx);
      const value = line.slice(idx + 1).trim();
      return miniCard(label, value, value.includes('-') ? 'negative' : value.includes('+') ? 'positive' : '');
    })
    .join('');
  return `<div class="portfolio-strip">${cards || miniCard('Portfolio', 'No PnL yet', '')}</div>${note ? `<div class="portfolio-note">${escapeHtml(note.replace(/^note:\s*/i, ''))}</div>` : ''}`;
}

function renderOpsCronGrid(crons: DashboardOpsCron[]): string {
  if (crons.length === 0) return '<div class="empty-state">No Hermes ops cron metadata configured.</div>';
  return `<div class="ops-grid">${crons.map(cron => `<article class="ops-card ${cron.tone}">
    <div class="signal-main"><span>${escapeHtml(cron.name)}</span><span class="signal-badge ${cron.tone}">${escapeHtml(cron.schedule)}</span></div>
    <div class="ops-meta">
      <div><strong>job:</strong> ${escapeHtml(cron.jobId)}</div>
      <div><strong>script:</strong> ${escapeHtml(cron.script)}</div>
      <div><strong>purpose:</strong> ${escapeHtml(cron.purpose)}</div>
      <div><strong>behavior:</strong> ${escapeHtml(cron.behavior)}</div>
    </div>
  </article>`).join('')}</div>`;
}

function renderTradeGrid(trades: DashboardPaperTrade[], kind: 'open' | 'closed'): string {
  if (trades.length === 0) return `<div class="empty-state">No ${kind} paper trades yet.</div>`;
  return `<div class="trade-grid">${trades.map(trade => renderTradeCard(trade, kind)).join('')}</div>`;
}

function renderTradeCard(trade: DashboardPaperTrade, kind: 'open' | 'closed'): string {
  const pnl = trade.status === 'closed' ? trade.pnlPercent ?? null : trade.lastPnlPercent ?? null;
  const positionPnlSol = positionPnlSolForTrade(trade);
  const positionPnlText = positionPnlSol == null ? 'n/a' : formatSignedSol(positionPnlSol);
  const pnlText = pnl == null ? 'n/a' : `${formatSigned(pnl)}%`;
  const pnlClassName = sentimentClass(pnl);
  const remaining = clampNumber(trade.remainingPercent, 0, 100);
  const drawdownFromPeak = trade.lastMultiplier != null && trade.maxMultiplier > 0
    ? ((trade.lastMultiplier / trade.maxMultiplier) - 1) * 100
    : null;
  const openedAgo = formatDuration(nowSeconds() - trade.entryTime);
  const checkedAgo = trade.lastCheckedAt == null ? 'never' : `${formatDuration(nowSeconds() - trade.lastCheckedAt)} ago`;
  const signal = trade.signalId == null ? 'n/a' : `#${trade.signalId}`;
  const statusText = trade.status === 'open' ? 'PAPER OPEN' : `CLOSED${trade.exitReason ? ` · ${trade.exitReason}` : ''}`;

  return `<article class="trade-card ${kind}">
    <div class="trade-head">
      <div class="token-title"><span class="token-symbol">$${escapeHtml(trade.symbol)}</span><span class="token-id">#${trade.id} · ${shortAddress(trade.tokenAddress)}</span></div>
      <div class="pnl-badge ${pnlClassName}">${escapeHtml(pnlText)}</div>
    </div>
    <div class="samples"><span class="chip">${escapeHtml(statusText)}</span><span class="chip">signal ${escapeHtml(signal)}</span><span class="chip">${trade.entrySol.toFixed(3)} SOL</span></div>
    <div class="stat-grid">
      ${stat('Current', trade.lastPriceUsd == null ? 'n/a' : formatUsdPrice(trade.lastPriceUsd), pnlClassName)}
      ${stat('Multiplier', trade.lastMultiplier == null ? 'n/a' : `${trade.lastMultiplier.toFixed(2)}x`, pnlClassName)}
      ${stat('Position PnL', positionPnlText, sentimentClass(positionPnlSol))}
      ${stat('Liquidity', trade.lastLiquidityUsd == null ? 'n/a' : formatCompactUsd(trade.lastLiquidityUsd), '')}
      ${stat('Entry', formatUsdPrice(trade.entryPriceUsd), '')}
      ${stat('Peak', `${trade.maxMultiplier.toFixed(2)}x`, trade.maxMultiplier >= 2 ? 'positive' : '')}
      ${stat('Drawdown', drawdownFromPeak == null ? 'n/a' : `${formatSigned(drawdownFromPeak)}%`, sentimentClass(drawdownFromPeak))}
    </div>
    <div class="bar ${pnl != null && pnl < 0 ? 'negative' : ''}" title="remaining inventory"><span style="--w:${remaining.toFixed(0)}%"></span></div>
    <div class="exec-strip">
      ${execItem('Slippage', trade.estimatedSlippageBps == null ? 'n/a' : `${formatSigned(trade.estimatedSlippageBps)} bps`, sentimentClass(trade.estimatedSlippageBps))}
      ${execItem('$100 check', trade.comparisonSlippageBps == null ? 'n/a' : `${formatSigned(trade.comparisonSlippageBps)} bps`, sentimentClass(trade.comparisonSlippageBps == null ? null : -trade.comparisonSlippageBps))}
      ${execItem('Latest wallet→fill', trade.latestWalletToFillSeconds == null ? 'n/a' : formatDuration(trade.latestWalletToFillSeconds), '')}
      ${execItem('Last check', checkedAgo, '')}
    </div>
    <div class="section-caption">Opened ${escapeHtml(openedAgo)} ago · fill model ${escapeHtml(trade.fillModel ?? 'n/a')} · ${escapeHtml(trade.liquidityConfidence ?? 'unknown')} confidence</div>
  </article>`;
}

function renderWalletGrid(wallets: WalletPerformance[]): string {
  if (wallets.length === 0) return '<div class="empty-state">No wallet attribution history yet.</div>';
  return `<div class="wallet-grid">${wallets.map(renderWalletCard).join('')}</div>`;
}

function renderWalletCard(wallet: WalletPerformance): string {
  const recClass = wallet.recommendation;
  return `<article class="wallet-card ${recClass}">
    <div class="wallet-head">
      <div>
        <h3>${escapeHtml(wallet.label)}</h3>
        <div class="section-caption">${shortAddress(wallet.address)}</div>
      </div>
      <span class="recommendation ${recClass}">${escapeHtml(wallet.recommendation.replace('_', ' '))}</span>
    </div>
    <div class="alpha-line"><div class="alpha-score">${wallet.alphaScore}</div><div class="alpha-bar"><span style="--w:${clampNumber(wallet.alphaScore, 0, 100)}%"></span></div></div>
    <div class="wallet-stats">
      ${stat('Pass rate', wallet.passRatePercent == null ? 'n/a' : `${wallet.passRatePercent.toFixed(1)}%`, '')}
      ${stat('Win rate', wallet.winRatePercent == null ? 'n/a' : `${wallet.winRatePercent.toFixed(1)}%`, sentimentClass(wallet.winRatePercent == null ? null : wallet.winRatePercent - 50))}
      ${stat('Avg PnL', wallet.avgPnlPercent == null ? 'n/a' : `${formatSigned(wallet.avgPnlPercent)}%`, sentimentClass(wallet.avgPnlPercent))}
      ${stat('Trades', `${wallet.paperTrades} / ${wallet.closedTrades}`, '')}
      ${stat('Slip', wallet.avgSlippageBps == null ? 'n/a' : `${formatSigned(wallet.avgSlippageBps)} bps`, sentimentClass(wallet.avgSlippageBps == null ? null : -wallet.avgSlippageBps))}
      ${stat('Latency', wallet.avgLatestWalletToFillSeconds == null ? 'n/a' : formatDuration(wallet.avgLatestWalletToFillSeconds), '')}
      ${stat('Exposure', `${wallet.openExposureSol.toFixed(3)} SOL`, wallet.openExposureSol > 0 ? 'warning' : '')}
      ${stat('Trust', `${formatTrust(wallet.currentTrust)}→${formatTrust(wallet.suggestedTrust)}`, '')}
    </div>
    <div class="wallet-reason">${escapeHtml(wallet.reason)} · bad streak ${wallet.badSignalStreak}</div>
    ${wallet.sampleSymbols.length === 0 ? '' : `<div class="samples">${wallet.sampleSymbols.slice(0, 5).map(symbol => `<span class="sample-chip">${escapeHtml(symbol)}</span>`).join('')}</div>`}
  </article>`;
}

function renderSignalCards(lines: string[]): string {
  if (lines.length === 0) return '<div class="empty-state">No recent signals yet.</div>';
  const groups: { head: string; meta: string[] }[] = [];
  for (const line of lines) {
    if (line.startsWith('#') || groups.length === 0) {
      groups.push({ head: line, meta: [] });
    } else {
      groups[groups.length - 1].meta.push(line.trim());
    }
  }
  return `<div class="signal-list">${groups.map(group => {
    const pass = group.head.includes('pass=true');
    return `<article class="signal-card"><div class="signal-main"><span>${escapeHtml(group.head)}</span><span class="signal-badge ${pass ? 'positive' : 'warning'}">${pass ? 'pass' : 'skip'}</span></div>${group.meta.length === 0 ? '' : `<div class="signal-meta">${escapeHtml(group.meta.join(' · '))}</div>`}</article>`;
  }).join('')}</div>`;
}

function formatRecentSignals(signals: any[]): string[] {
  const lines: string[] = [];
  for (const s of signals) {
    lines.push(`#${s.id} $${s.symbol} score=${s.composite_score}/100 pass=${Boolean(s.pass)} wallets=${s.wallet_count} ${shortAddress(s.token_address)}`);
    const reasons = normalizeSignalReasonText(String(s.fail_reasons || '').trim(), s.score_json);
    const warnings = String(s.warnings || '').trim();
    if (reasons) lines.push(`  reasons: ${reasons}`);
    if (warnings) lines.push(`  warnings: ${warnings}`);
  }
  return lines;
}

function metricCard(label: string, value: string, className: string): string {
  return `<div class="metric-card"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value ${className}">${escapeHtml(value)}</div></div>`;
}

function miniCard(label: string, value: string, className: string): string {
  return `<div class="mini-card"><div class="mini-label">${escapeHtml(label)}</div><div class="mini-value ${className}">${escapeHtml(value)}</div></div>`;
}

function stat(label: string, value: string, className: string): string {
  return `<div class="stat"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value ${className}">${escapeHtml(value)}</div></div>`;
}

function execItem(label: string, value: string, className: string): string {
  return `<div class="exec-item"><div class="exec-label">${escapeHtml(label)}</div><div class="exec-value ${className}">${escapeHtml(value)}</div></div>`;
}

function pre(value: string): string {
  return `<pre>${escapeHtml(value)}</pre>`;
}

function sentimentClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '';
  if (value > 0) return 'positive';
  if (value < 0) return 'negative';
  return '';
}

function formatSigned(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
}

function formatSignedSol(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)} SOL`;
}

function positionPnlSolForTrade(trade: DashboardPaperTrade): number | null {
  if (trade.positionPnlSol != null && Number.isFinite(trade.positionPnlSol)) return trade.positionPnlSol;
  if (trade.positionPnlPercent != null && Number.isFinite(trade.positionPnlPercent) && trade.entrySol > 0) {
    return trade.entrySol * (trade.positionPnlPercent / 100);
  }

  const pnlPercent = simplePnlPercentForTrade(trade);
  if (pnlPercent == null || !Number.isFinite(pnlPercent) || trade.entrySol <= 0) return null;
  const exposureSol = trade.status === 'closed'
    ? trade.entrySol
    : trade.entrySol * (clampNumber(trade.remainingPercent, 0, 100) / 100);
  return exposureSol * (pnlPercent / 100);
}

function simplePnlPercentForTrade(trade: PaperTrade): number | null {
  if (trade.status === 'closed') {
    if (trade.pnlPercent != null && Number.isFinite(trade.pnlPercent)) return trade.pnlPercent;
    if (trade.exitPriceUsd != null && trade.entryPriceUsd > 0) return ((trade.exitPriceUsd / trade.entryPriceUsd) - 1) * 100;
    return null;
  }
  if (trade.lastPnlPercent != null && Number.isFinite(trade.lastPnlPercent)) return trade.lastPnlPercent;
  if (trade.lastMultiplier != null && Number.isFinite(trade.lastMultiplier)) return (trade.lastMultiplier - 1) * 100;
  if (trade.lastPriceUsd != null && trade.entryPriceUsd > 0) return ((trade.lastPriceUsd / trade.entryPriceUsd) - 1) * 100;
  return null;
}

function formatTrust(value: number | null): string {
  return value == null ? 'n/a' : value.toFixed(2);
}

function formatCompactUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function formatUsdPrice(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  if (Math.abs(value) >= 1) return `$${value.toFixed(4)}`;
  if (Math.abs(value) >= 0.0001) return `$${value.toFixed(8)}`;
  return `$${value.toFixed(10)}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'n/a';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function send(res: http.ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
