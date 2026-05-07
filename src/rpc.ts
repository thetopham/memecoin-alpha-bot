export class SolanaRpcClient {
  constructor(private readonly url: string) {}

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    });
    if (!res.ok) throw new Error(`Solana RPC HTTP ${res.status} for ${method}`);
    const data = await res.json() as { result?: T; error?: { message?: string; code?: number } };
    if (data.error) throw new Error(`Solana RPC ${method} failed: ${data.error.message ?? data.error.code}`);
    return data.result as T;
  }

  async getSignaturesForAddress(address: string, limit: number): Promise<Array<{ signature: string; blockTime?: number | null; err?: unknown }>> {
    return this.call('getSignaturesForAddress', [address, { limit, commitment: 'confirmed' }]);
  }

  async getParsedTransaction(signature: string): Promise<any | null> {
    return this.call('getTransaction', [signature, {
      encoding: 'jsonParsed',
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    }]);
  }
}
