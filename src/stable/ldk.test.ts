import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Option_u64Z,
  Option_u64Z_Some,
  type RecipientOnionFields,
  type RouteParameters,
} from 'lightningdevkit'
import { getPublicKey } from '@noble/secp256k1'
import { initializeTestLdk } from '../test/initialize-ldk-wasm'
import type { LdkNode } from '../ldk/init'
import { persistPayment, updatePaymentStatus } from '../ldk/storage/payment-history'
import { providerChannel, sendStableKeysend } from './ldk'
import type { StableIntent } from './types'

vi.mock('../ldk/storage/payment-history', () => ({
  persistPayment: vi.fn(),
  updatePaymentStatus: vi.fn(),
}))

describe('Stable Channels direct keysend (real WASM)', () => {
  const nodeId = getPublicKey(new Uint8Array(32).fill(7))
  const provider = {
    nodeId: Array.from(nodeId, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    host: 'provider.example',
    port: 9735,
  }
  const channelId = '1'.repeat(64)
  let outbound: bigint
  let node: LdkNode
  const sendPayment = vi.fn<
    (...args: Parameters<LdkNode['channelManager']['send_spontaneous_payment']>) => {
      is_ok: () => boolean
    }
  >(() => ({ is_ok: () => true }))
  const intent: StableIntent = {
    kind: 'trade',
    paymentId: '2'.repeat(64),
    preimage: '3'.repeat(64),
    channelId,
    amountMsat: '1010000',
    backingSats: '100000',
    targetUsd: 100,
    tlv: '13377331',
    payload: '{"payload":"signed request","signature":"signature"}',
    createdAt: 1,
    sent: false,
    correlation: null,
  }
  beforeAll(initializeTestLdk)
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(persistPayment).mockResolvedValue(undefined)
    outbound = 200_000_000n
    const channel = {
      get_counterparty: () => ({ get_node_id: () => nodeId }),
      get_channel_id: () => ({ write: () => new Uint8Array(32).fill(0x11) }),
      get_user_channel_id: () => 7n,
      get_outbound_capacity_msat: () => outbound,
      get_inbound_capacity_msat: () => 300_000_000n,
      get_unspendable_punishment_reserve: () => Option_u64Z.constructor_some(1000n),
      get_is_usable: () => true,
      get_is_channel_ready: () => true,
    }
    node = {
      channelManager: {
        list_channels: () => [channel],
        send_spontaneous_payment: sendPayment,
      },
      peerManager: { process_events: vi.fn() },
    } as unknown as LdkNode
  })
  it('includes the local reserve when measuring ownership', () => {
    expect(providerChannel(node, provider)).toMatchObject({
      receiverSats: 201_000n,
      spendableSats: 200_000n,
      inboundSats: 300_000n,
    })
  })
  it('sends signed custom metadata in one direct path with zero routing fees', async () => {
    await sendStableKeysend(node, provider, intent, () => true)
    const call = sendPayment.mock.calls[0]!
    const fields: RecipientOnionFields = call[1]
    expect(fields.custom_tlvs()[0]!.get_a()).toBe(13377331n)
    expect(new TextDecoder().decode(fields.custom_tlvs()[0]!.get_b())).toBe(intent.payload)
    const route: RouteParameters = call[3]
    expect(route.get_final_value_msat()).toBe(1_010_000n)
    expect(route.get_payment_params().get_max_path_count()).toBe(1)
    expect(route.get_payment_params().get_max_path_length()).toBe(1)
    expect((route.get_max_total_routing_fee_msat() as Option_u64Z_Some).some).toBe(0n)
    expect(persistPayment).toHaveBeenCalledBefore(sendPayment)
  })
  it('rejects a capacity change during asynchronous history persistence', async () => {
    vi.mocked(persistPayment).mockImplementation(() => {
      outbound = 50_000_000n
      return Promise.resolve()
    })
    await expect(sendStableKeysend(node, provider, intent, () => true)).rejects.toThrow(/changed/)
    expect(sendPayment).not.toHaveBeenCalled()
    expect(updatePaymentStatus).toHaveBeenCalledWith(
      intent.paymentId,
      'failed',
      0n,
      expect.any(String)
    )
  })
  it('sends a full-balance allocation without retaining a percentage or sat buffer', async () => {
    await sendStableKeysend(
      node,
      provider,
      {
        ...intent,
        amountMsat: '2010000',
        backingSats: '198990',
        targetUsd: 198.99,
      },
      () => true
    )
    expect(sendPayment).toHaveBeenCalledTimes(1)
  })
})
