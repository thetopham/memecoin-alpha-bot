import fs from 'fs';
import path from 'path';
import type { WalletConfig } from './types';

export const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isSolanaWalletAddress(value: unknown): value is string {
  return typeof value === 'string' && SOLANA_ADDRESS_RE.test(value.trim());
}

export function normalizeWallet(input: WalletConfig): WalletConfig {
  const address = input.address?.trim();
  if (!address || !isSolanaWalletAddress(address)) {
    throw new Error(`Invalid Solana wallet address: ${input.address}`);
  }
  return {
    address,
    label: input.label?.trim() || undefined,
    trust: typeof input.trust === 'number' && Number.isFinite(input.trust) ? input.trust : 1,
    enabled: input.enabled !== false,
  };
}

export function loadWallets(filePath: string): WalletConfig[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as WalletConfig[];
  if (!Array.isArray(raw)) throw new Error(`Wallet config must be an array: ${filePath}`);
  return raw.map(normalizeWallet).filter(w => w.enabled !== false);
}

export function addWallet(filePath: string, address: string, label?: string, trust = 1): WalletConfig[] {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const current = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) as WalletConfig[] : [];
  const wallet = normalizeWallet({ address, label, trust, enabled: true });
  const existing = current.findIndex(w => w.address === wallet.address);
  if (existing >= 0) current[existing] = { ...current[existing], ...wallet };
  else current.push(wallet);
  fs.writeFileSync(filePath, `${JSON.stringify(current, null, 2)}\n`);
  return current.map(normalizeWallet).filter(w => w.enabled !== false);
}
