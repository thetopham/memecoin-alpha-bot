import type { AppConfig, ConvergenceSignal, PaperTrade, TokenScore } from './types';
import { formatLiquidity, formatPct, formatUsd, shortAddress } from './utils';

export class Notifier {
  constructor(private readonly cfg: Pick<AppConfig, 'telegramBotToken' | 'telegramChatId'>) {}

  async send(message: string): Promise<void> {
    if (!this.cfg.telegramBotToken || !this.cfg.telegramChatId) {
      console.log(`\n[ALERT]\n${message}\n`);
      return;
    }
    const res = await fetch(`https://api.telegram.org/bot${this.cfg.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.cfg.telegramChatId,
        text: message,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) throw new Error(`Telegram send failed HTTP ${res.status}`);
  }

  async signal(signal: ConvergenceSignal, score: TokenScore, paperSol: number, signalId: number): Promise<void> {
    const wallets = signal.wallets.map(w => `${w.label ?? shortAddress(w.wallet)}:${w.solAmount.toFixed(2)} SOL`).join(', ');
    const snap = score.snapshot;
    await this.send([
      `🟢 SIGNAL #${signalId}: $${score.symbol}`,
      `mint: ${signal.tokenAddress}`,
      `wallets in: ${signal.walletCount} (${wallets})`,
      `convergence: ${signal.windowSeconds}s | trust: ${signal.weightedTrust.toFixed(2)}`,
      `score: ${score.composite}/100 → PAPER ENTER ${paperSol.toFixed(3)} SOL`,
      `volume: ${formatUsd(snap.volume24hUsd)} 24h | ${formatUsd(snap.volume1hUsd)} 1h`,
      `liq: ${formatLiquidity(snap.liquidityUsd, snap.marketStage)} | top10: ${formatPct(snap.top10HolderPercent)}`,
      `flow 5m: ${snap.txns5mBuys} buys / ${snap.txns5mSells} sells`,
      snap.url ? `chart: ${snap.url}` : undefined,
    ].filter(Boolean).join('\n'));
  }

  async exit(trade: PaperTrade, reason: string, pnlPercent: number): Promise<void> {
    await this.send([
      `🔴 PAPER EXIT: $${trade.symbol}`,
      `mint: ${trade.tokenAddress}`,
      `reason: ${reason}`,
      `p&l: ${pnlPercent.toFixed(1)}%`,
      `max seen: ${trade.maxMultiplier.toFixed(2)}x`,
    ].join('\n'));
  }
}
