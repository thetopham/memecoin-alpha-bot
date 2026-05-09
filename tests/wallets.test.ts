import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { readWalletFile, writeWalletFile } from '../src/wallets';

describe('wallet file writes', () => {
  it('backs up the previous watchlist and atomically writes the replacement file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memecoin-alpha-wallets-'));
    const filePath = path.join(dir, 'wallets.json');
    fs.writeFileSync(filePath, `${JSON.stringify([{ address: '11111111111111111111111111111111', label: 'old', tier: 'hot' }], null, 2)}\n`);

    try {
      const backupPath = writeWalletFile(filePath, [{ address: '22222222222222222222222222222222', label: 'new', tier: 'candidate' }]);

      expect(backupPath).toBeTruthy();
      expect(fs.existsSync(backupPath as string)).toBe(true);
      expect(readWalletFile(backupPath as string)[0].label).toBe('old');
      expect(readWalletFile(filePath)[0]).toMatchObject({ address: '22222222222222222222222222222222', label: 'new', tier: 'candidate' });
      expect(fs.readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
