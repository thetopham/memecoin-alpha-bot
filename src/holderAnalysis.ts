import type { SolanaRpcClient } from './rpc';
import { toNumber } from './utils';

export async function getTop10HolderPercent(rpc: SolanaRpcClient, mint: string): Promise<number | null> {
  try {
    const supplyResult = await rpc.call<any>('getTokenSupply', [mint, { commitment: 'confirmed' }]);
    const supply = toNumber(supplyResult?.value?.uiAmountString ?? supplyResult?.value?.uiAmount, 0);
    if (supply <= 0) return null;

    const largest = await rpc.call<any>('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]);
    const values = Array.isArray(largest?.value) ? largest.value : [];
    const top10 = values.slice(0, 10).reduce((sum: number, account: any) => {
      return sum + toNumber(account?.uiAmountString ?? account?.uiAmount, 0);
    }, 0);
    return (top10 / supply) * 100;
  } catch {
    return null;
  }
}
