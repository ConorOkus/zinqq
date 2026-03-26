import { renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, it, expect } from 'vitest'
import {
  OnchainContext,
  defaultOnchainContextValue,
  type OnchainContextValue,
} from '../onchain/onchain-context'
import { LdkContext, defaultLdkContextValue, type LdkContextValue } from '../ldk/ldk-context'
import { useUnifiedBalance } from './use-unified-balance'

/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/require-await, react/display-name */

function readyOnchain(
  overrides?: Partial<Extract<OnchainContextValue, { status: 'ready' }>>
): OnchainContextValue {
  return {
    status: 'ready',
    balance: { confirmed: 100_000n, trustedPending: 5_000n, untrustedPending: 500n },
    generateAddress: () => 'tb1qtest',
    estimateFee: async () => ({ fee: 245n, feeRate: 2n }),
    estimateMaxSendable: async () => ({ amount: 99_000n, fee: 1_000n, feeRate: 2n }),
    sendToAddress: async () => 'txid123',
    sendMax: async () => 'txid123',
    syncNow: () => {},
    listTransactions: () => [],
    error: null,
    ...overrides,
  }
}

function readyLdk(
  overrides?: Partial<Extract<LdkContextValue, { status: 'ready' }>>
): LdkContextValue {
  return {
    status: 'ready',
    node: {} as never,
    nodeId: 'abc123',
    error: null,
    syncStatus: 'synced',
    connectToPeer: async () => {},
    forgetPeer: async () => {},
    createChannel: () => true,
    closeChannel: () => true,
    forceCloseChannel: () => true,
    listChannels: () => [],
    bdkWallet: {} as never,
    bdkEsploraClient: {} as never,
    setSyncNeeded: () => {},
    sendBolt11Payment: () => new Uint8Array(32),
    sendBolt12Payment: () => new Uint8Array(32),
    abandonPayment: () => {},
    getPaymentResult: () => null,
    listRecentPayments: () => [],
    outboundCapacityMsat: () => 50_000_000n,
    lightningBalanceSats: 50_000n,
    createInvoice: () => 'lnbc1test',
    channelChangeCounter: 0,
    peersReconnected: true,
    paymentHistory: [],
    bolt12Offer: null,
    vssStatus: 'ok',
    shutdown: () => {},
    ...overrides,
  }
}

function wrapper(ldkValue: LdkContextValue, onchainValue: OnchainContextValue) {
  return ({ children }: { children: ReactNode }) =>
    createElement(
      LdkContext,
      { value: ldkValue },
      createElement(OnchainContext, { value: onchainValue }, children)
    )
}

describe('useUnifiedBalance', () => {
  it('combines onchain and lightning balances', () => {
    const { result } = renderHook(() => useUnifiedBalance(), {
      wrapper: wrapper(readyLdk(), readyOnchain()),
    })
    expect(result.current.onchain).toBe(105_500n) // confirmed + trustedPending + untrustedPending
    expect(result.current.lightning).toBe(50_000n)
    expect(result.current.total).toBe(155_500n)
    expect(result.current.pending).toBe(500n)
    expect(result.current.isLoading).toBe(false)
  })

  it('returns zero lightning when no channels', () => {
    const { result } = renderHook(() => useUnifiedBalance(), {
      wrapper: wrapper(readyLdk({ lightningBalanceSats: 0n }), readyOnchain()),
    })
    expect(result.current.lightning).toBe(0n)
    expect(result.current.total).toBe(105_500n)
  })

  it('returns zero onchain when only lightning funded', () => {
    const { result } = renderHook(() => useUnifiedBalance(), {
      wrapper: wrapper(
        readyLdk(),
        readyOnchain({ balance: { confirmed: 0n, trustedPending: 0n, untrustedPending: 0n } })
      ),
    })
    expect(result.current.onchain).toBe(0n)
    expect(result.current.total).toBe(50_000n)
  })

  it('returns all zeros when both are zero', () => {
    const { result } = renderHook(() => useUnifiedBalance(), {
      wrapper: wrapper(
        readyLdk({ lightningBalanceSats: 0n }),
        readyOnchain({ balance: { confirmed: 0n, trustedPending: 0n, untrustedPending: 0n } })
      ),
    })
    expect(result.current.total).toBe(0n)
    expect(result.current.onchain).toBe(0n)
    expect(result.current.lightning).toBe(0n)
    expect(result.current.pending).toBe(0n)
  })

  it('shows loading when onchain is loading', () => {
    const { result } = renderHook(() => useUnifiedBalance(), {
      wrapper: wrapper(readyLdk(), defaultOnchainContextValue),
    })
    expect(result.current.isLoading).toBe(true)
    expect(result.current.total).toBe(50_000n) // lightning still contributes
  })

  it('shows loading when ldk is loading', () => {
    const { result } = renderHook(() => useUnifiedBalance(), {
      wrapper: wrapper(defaultLdkContextValue, readyOnchain()),
    })
    expect(result.current.isLoading).toBe(true)
    expect(result.current.total).toBe(105_500n) // onchain still contributes
  })

  it('shows loading when both are loading', () => {
    const { result } = renderHook(() => useUnifiedBalance(), {
      wrapper: wrapper(defaultLdkContextValue, defaultOnchainContextValue),
    })
    expect(result.current.isLoading).toBe(true)
    expect(result.current.total).toBe(0n)
  })

  it('includes untrustedPending in total after channel close', () => {
    // After cooperative close, closing tx funds land as untrustedPending
    // (BDK did not sign the closing tx — LDK did)
    const { result } = renderHook(() => useUnifiedBalance(), {
      wrapper: wrapper(
        readyLdk({ lightningBalanceSats: 0n }),
        readyOnchain({ balance: { confirmed: 0n, trustedPending: 0n, untrustedPending: 50_000n } })
      ),
    })
    expect(result.current.onchain).toBe(50_000n)
    expect(result.current.total).toBe(50_000n)
    expect(result.current.pending).toBe(50_000n)
  })
})
