import type { SwapSource, WalletSwapEvent } from './types';
import { toNumber } from './utils';

const DEX_PROGRAMS: Record<string, SwapSource> = {
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pumpfun',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'raydium',
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1': 'raydium',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'jupiter',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'orca',
};

const IGNORED_MINTS = new Set([
  'So11111111111111111111111111111111111111112', // WSOL
  'Es9vMFrzaCERmJfrF4H2FYD4KCoUS5zoFxPiu3yVTe7', // USDT
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
]);

function accountKeyToString(key: any): string {
  if (typeof key === 'string') return key;
  if (typeof key?.pubkey === 'string') return key.pubkey;
  if (key?.pubkey?.toString) return key.pubkey.toString();
  return String(key ?? '');
}

function tokenAmount(balance: any): number {
  return toNumber(balance?.uiTokenAmount?.uiAmountString ?? balance?.uiTokenAmount?.uiAmount, 0);
}

function tokenOwner(balance: any, accountKeys: string[]): string | undefined {
  if (typeof balance?.owner === 'string') return balance.owner;
  const index = balance?.accountIndex;
  return typeof index === 'number' ? accountKeys[index] : undefined;
}

function sourceFromKeys(accountKeys: string[]): SwapSource {
  for (const key of accountKeys) {
    if (DEX_PROGRAMS[key]) return DEX_PROGRAMS[key];
  }
  return 'unknown';
}

interface TokenDelta {
  mint: string;
  delta: number;
}

export function parseWalletSwap(tx: any, watchedWallet: string, fallbackTimestamp: number): WalletSwapEvent | null {
  try {
    const meta = tx?.meta;
    const transaction = tx?.transaction;
    if (!meta || !transaction || meta.err) return null;

    const accountKeys: string[] = (transaction.message?.accountKeys ?? []).map(accountKeyToString);
    if (!accountKeys.includes(watchedWallet)) return null;

    const source = sourceFromKeys(accountKeys);
    if (source === 'unknown') return null;

    const signerIndex = accountKeys.indexOf(watchedWallet);
    const preLamports = toNumber(meta.preBalances?.[signerIndex], 0);
    const postLamports = toNumber(meta.postBalances?.[signerIndex], 0);
    const solDelta = (postLamports - preLamports) / 1e9;

    const preByMint = new Map<string, number>();
    const postByMint = new Map<string, number>();

    for (const balance of meta.preTokenBalances ?? []) {
      if (tokenOwner(balance, accountKeys) !== watchedWallet) continue;
      preByMint.set(balance.mint, (preByMint.get(balance.mint) ?? 0) + tokenAmount(balance));
    }
    for (const balance of meta.postTokenBalances ?? []) {
      if (tokenOwner(balance, accountKeys) !== watchedWallet) continue;
      postByMint.set(balance.mint, (postByMint.get(balance.mint) ?? 0) + tokenAmount(balance));
    }

    const mints = new Set([...preByMint.keys(), ...postByMint.keys()]);
    const deltas: TokenDelta[] = [...mints]
      .filter(mint => !IGNORED_MINTS.has(mint))
      .map(mint => ({ mint, delta: (postByMint.get(mint) ?? 0) - (preByMint.get(mint) ?? 0) }))
      .filter(d => Math.abs(d.delta) > 0);

    if (deltas.length === 0 || Math.abs(solDelta) < 0.000001) return null;

    const direction = solDelta < 0 ? 'buy' : 'sell';
    const primary = direction === 'buy'
      ? deltas.filter(d => d.delta > 0).sort((a, b) => b.delta - a.delta)[0]
      : deltas.filter(d => d.delta < 0).sort((a, b) => a.delta - b.delta)[0];

    if (!primary) return null;

    const signature = tx.signature ?? transaction.signatures?.[0];
    if (!signature) return null;

    return {
      wallet: watchedWallet,
      tokenAddress: primary.mint,
      direction,
      solAmount: Math.abs(solDelta),
      txHash: signature,
      timestamp: tx.blockTime ?? fallbackTimestamp,
      source,
    };
  } catch {
    return null;
  }
}
