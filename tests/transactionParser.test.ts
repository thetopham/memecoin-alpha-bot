import { describe, expect, it } from 'vitest';
import { parseWalletSwap } from '../src/transactionParser';

describe('parseWalletSwap', () => {
  it('extracts a token buy when wallet SOL decreases and token balance increases', () => {
    const tx = {
      signature: 'sig1',
      transaction: {
        message: {
          accountKeys: [
            { pubkey: 'walletA', signer: true },
            { pubkey: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P' }
          ]
        },
        signatures: ['sig1']
      },
      meta: {
        err: null,
        preBalances: [2_000_000_000, 0],
        postBalances: [1_250_000_000, 0],
        preTokenBalances: [{ accountIndex: 0, mint: 'mintX', owner: 'walletA', uiTokenAmount: { uiAmountString: '0' } }],
        postTokenBalances: [{ accountIndex: 0, mint: 'mintX', owner: 'walletA', uiTokenAmount: { uiAmountString: '1000000' } }]
      }
    };

    const event = parseWalletSwap(tx, 'walletA', 1234);

    expect(event?.direction).toBe('buy');
    expect(event?.tokenAddress).toBe('mintX');
    expect(event?.solAmount).toBeCloseTo(0.75);
    expect(event?.source).toBe('pumpfun');
  });

  it('extracts a token sell when wallet SOL increases and token balance decreases', () => {
    const tx = {
      signature: 'sig2',
      transaction: { message: { accountKeys: [{ pubkey: 'walletA' }, { pubkey: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' }] }, signatures: ['sig2'] },
      meta: {
        err: null,
        preBalances: [1_000_000_000, 0],
        postBalances: [1_400_000_000, 0],
        preTokenBalances: [{ accountIndex: 0, mint: 'mintX', owner: 'walletA', uiTokenAmount: { uiAmountString: '1000' } }],
        postTokenBalances: [{ accountIndex: 0, mint: 'mintX', owner: 'walletA', uiTokenAmount: { uiAmountString: '100' } }]
      }
    };

    const event = parseWalletSwap(tx, 'walletA', 1235);

    expect(event?.direction).toBe('sell');
    expect(event?.tokenAddress).toBe('mintX');
    expect(event?.solAmount).toBeCloseTo(0.4);
    expect(event?.source).toBe('jupiter');
  });
});
