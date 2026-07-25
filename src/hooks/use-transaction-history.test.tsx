import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'

const idbData = new Map<string, unknown>()
vi.mock('../storage/idb', () => ({
  idbGet: vi.fn((_store: string, key: string) => Promise.resolve(idbData.get(key))),
  idbPut: vi.fn((_store: string, key: string, value: unknown) => {
    idbData.set(key, value)
    return Promise.resolve()
  }),
}))
vi.mock('../ldk/storage/vss-client', () => ({ isVssConflict: () => false }))
vi.mock('../storage/error-log', () => ({ captureError: vi.fn() }))

import { LdkContext, type LdkContextValue } from '../ldk/ldk-context'
import { OnchainContext, type OnchainContextValue } from '../onchain/onchain-context'
import { useTransactionHistory } from './use-transaction-history'
import { resetCloseRecordsForTest, upsertCloseRecord } from '../ldk/close-records/store'
import { CLOSE_RECORD_SCHEMA_VERSION, type CloseRecord } from '../ldk/close-records/close-record'

interface OnchainTx {
  txid: string
  sent: bigint
  received: bigint
  confirmationTime?: bigint
  firstSeen?: bigint
  isConfirmed: boolean
}

function readyOnchain(txs: OnchainTx[]): OnchainContextValue {
  return {
    status: 'ready',
    balance: { confirmed: 100_000n, trustedPending: 0n, untrustedPending: 0n },
    generateAddress: () => 'bc1qtest',
    estimateFee: () => Promise.resolve({ fee: 245n, feeRate: 2n }),
    estimateMaxSendable: () => Promise.resolve({ amount: 99_000n, fee: 1_000n, feeRate: 2n }),
    sendToAddress: () => Promise.resolve('txid123'),
    sendMax: () => Promise.resolve('txid123'),
    syncNow: () => {},
    listTransactions: () => txs as never,
    error: null,
  }
}

function readyLdk(): LdkContextValue {
  return {
    status: 'ready',
    node: {} as never,
    nodeId: 'abc123',
    error: null,
    syncStatus: 'synced',
    connectToPeer: () => Promise.resolve(),
    forgetPeer: () => Promise.resolve(),
    disconnectPeer: () => {},
    createChannel: () => true,
    closeChannel: () => true,
    forceCloseChannel: () => true,
    estimateClose: () => Promise.resolve(null),
    listChannels: () => [],
    bdkWallet: {} as never,
    bdkEsploraClient: {} as never,
    setSyncNeeded: () => {},
    sendBolt11Payment: () => new Uint8Array(),
    sendBolt12Payment: () => Promise.resolve(new Uint8Array()),
    abandonPayment: () => {},
    getPaymentResult: () => null,
    listRecentPayments: () => [],
    outboundCapacityMsat: () => 0n,
    lightningBalanceSats: 0n,
    createInvoice: () => ({ bolt11: 'lnbc1test', paymentHash: 'abc123' }),
    requestJitQuote: () => Promise.reject(new Error('unused')),
    fetchMinJitReceiveSats: () => Promise.resolve(0n),
    executeJitBuy: () => Promise.reject(new Error('unused')),
    channelChangeCounter: 0,
    peersReconnected: true,
    paymentHistory: [],
    bolt12Offer: null,
    vssStatus: 'ok',
    vssClient: null,
    shutdown: () => {},
  }
}

function record(channelId: string, overrides: Partial<CloseRecord> = {}): CloseRecord {
  return {
    schemaVersion: CLOSE_RECORD_SCHEMA_VERSION,
    channelId,
    closeType: 'force',
    initiator: 'local',
    txs: [],
    createdAt: 1000,
    ...overrides,
  }
}

function run(onchainTxs: OnchainTx[]) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <LdkContext value={readyLdk()}>
      <OnchainContext value={readyOnchain(onchainTxs)}>{children}</OnchainContext>
    </LdkContext>
  )
  return renderHook(() => useTransactionHistory(), { wrapper })
}

const SWEEP_RECEIVE: OnchainTx = {
  txid: 'sweep-tx',
  sent: 0n,
  received: 48_000n,
  confirmationTime: 1_700_000_000n,
  isConfirmed: true,
}

beforeEach(() => {
  idbData.clear()
  resetCloseRecordsForTest()
})

describe('useTransactionHistory — channel closes', () => {
  it('absorbs close-owned txids: never double-listed as bare receives', async () => {
    await upsertCloseRecord(
      record('ab', {
        expectedAmountSats: 48_000n,
        txs: [{ txid: 'sweep-tx', role: 'sweep', confirmedAtHeight: 100 }],
      })
    )
    const { result } = run([SWEEP_RECEIVE])

    const bareRow = result.current.transactions.find((t) => t.id === 'sweep-tx')
    expect(bareRow).toBeUndefined()
    const closeRows = result.current.transactions.filter((t) => t.layer === 'channel-close')
    expect(closeRows).toHaveLength(1)
    expect(closeRows[0]?.amountSats).toBe(48_000n)
  })

  it('pre-feature closes stay raw receives (no record → no absorption)', () => {
    const { result } = run([SWEEP_RECEIVE])
    expect(result.current.transactions.find((t) => t.id === 'sweep-tx')).toBeDefined()
    expect(result.current.transactions.some((t) => t.layer === 'channel-close')).toBe(false)
  })

  it('unknown amounts render null, never 0', async () => {
    await upsertCloseRecord(record('ab'))
    const { result } = run([])
    const row = result.current.transactions.find((t) => t.layer === 'channel-close')
    expect(row?.amountSats).toBeNull()
  })

  it('close rows sort by createdAt and expose derived status', async () => {
    await upsertCloseRecord(record('ab', { completedAt: 5, resolution: 'verified' }))
    const { result } = run([])
    const row = result.current.transactions.find((t) => t.layer === 'channel-close')
    expect(row?.closeStatus).toBe('complete')
    expect(row?.status).toBe('confirmed')
    expect(row?.timestamp).toBe(1000)
  })
})
