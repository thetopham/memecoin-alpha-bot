import fs from 'fs';
import path from 'path';
import type { WalletConfig, WalletTier } from './types';

export const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const WALLET_TIERS: WalletTier[] = ['hot', 'probation', 'candidate', 'archive'];

export function isSolanaWalletAddress(value: unknown): value is string {
  return typeof value === 'string' && SOLANA_ADDRESS_RE.test(value.trim());
}

export function normalizeWalletTier(value: unknown): WalletTier {
  return WALLET_TIERS.includes(value as WalletTier) ? value as WalletTier : 'hot';
}

export function normalizeWallet(input: WalletConfig): WalletConfig {
  const address = input.address?.trim();
  if (!address || !isSolanaWalletAddress(address)) {
    throw new Error(`Invalid Solana wallet address: ${input.address}`);
  }
  const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim() : undefined;
  const source = typeof input.source === 'string' && input.source.trim() ? input.source.trim() : undefined;
  const notes = typeof input.notes === 'string' && input.notes.trim() ? input.notes.trim() : undefined;
  return {
    ...input,
    address,
    label,
    trust: typeof input.trust === 'number' && Number.isFinite(input.trust) ? input.trust : 1,
    enabled: input.enabled !== false,
    tier: normalizeWalletTier(input.tier),
    source,
    notes,
  };
}

export function readWalletFile(filePath: string): WalletConfig[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as WalletConfig[];
  if (!Array.isArray(raw)) throw new Error(`Wallet config must be an array: ${filePath}`);
  return raw.map(normalizeWallet);
}

export interface WriteWalletFileOptions {
  backup?: boolean;
  backupDir?: string;
}

export function createWalletFileBackup(filePath: string, backupDir?: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const dir = backupDir ?? path.join(path.dirname(filePath), '.wallet-backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(dir, `${path.basename(filePath)}.${stamp}.bak`);
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

export function writeWalletFile(filePath: string, wallets: WalletConfig[], options: WriteWalletFileOptions = {}): string | null {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const backupPath = options.backup === false ? null : createWalletFileBackup(filePath, options.backupDir);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(wallets.map(normalizeWallet), null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  return backupPath;
}

export function loadWallets(filePath: string): WalletConfig[] {
  return readWalletFile(filePath).filter(w => w.enabled !== false && w.tier !== 'archive');
}

export function addWallet(filePath: string, address: string, label?: string, trust = 1, tier: WalletTier = 'hot'): WalletConfig[] {
  const current = readWalletFile(filePath);
  const wallet = normalizeWallet({ address, label, trust, enabled: true, tier });
  const existing = current.findIndex(w => w.address === wallet.address);
  if (existing >= 0) current[existing] = { ...current[existing], ...wallet };
  else current.push(wallet);
  writeWalletFile(filePath, current);
  return current.map(normalizeWallet).filter(w => w.enabled !== false && w.tier !== 'archive');
}
