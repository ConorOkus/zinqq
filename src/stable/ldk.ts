import {
  Event_PaymentClaimed,
  Event_PaymentSent,
  Event_PaymentFailed,
  Option_ThirtyTwoBytesZ,
  Option_ThirtyTwoBytesZ_Some,
  Option_u64Z,
  Option_u64Z_Some,
  RecipientOnionFields,
  Result_RecipientOnionFieldsNoneZ_OK,
  TwoTuple_u64CVec_u8ZZ,
  PaymentParameters,
  RouteParameters,
  Retry,
  UtilMethods,
  RecentPaymentDetails_Pending,
  RecentPaymentDetails_AwaitingInvoice,
  type Event as LdkEvent,
} from 'lightningdevkit'
import { bytesToHex, hexToBytes } from '../ldk/utils'
import type { LdkNode } from '../ldk/init'
import { persistPayment, updatePaymentStatus } from '../ldk/storage/payment-history'
import { StableSendRejected } from './client'
import type { StableChannel, StableIntent, StablePaymentEvent, StableProvider } from './types'

export function providerChannel(node: LdkNode, provider: StableProvider): StableChannel | null {
  const matches = node.channelManager
    .list_channels()
    .filter((ch) => bytesToHex(ch.get_counterparty().get_node_id()) === provider.nodeId)
  if (matches.length > 1) throw new Error('Use one direct channel to the stability provider')
  const ch = matches[0]
  if (!ch) return null
  const spendableSats = ch.get_outbound_capacity_msat() / 1000n
  const reserve = ch.get_unspendable_punishment_reserve()
  return {
    channelId: bytesToHex(ch.get_channel_id().write()),
    userChannelId: ch.get_user_channel_id().toString(),
    spendableSats,
    inboundSats: ch.get_inbound_capacity_msat() / 1000n,
    receiverSats: spendableSats + (reserve instanceof Option_u64Z_Some ? reserve.some : 0n),
    usable: ch.get_is_usable() && ch.get_is_channel_ready(),
  }
}

export function hasPendingPayments(node: LdkNode): boolean {
  return node.channelManager
    .list_recent_payments()
    .some(
      (payment) =>
        payment instanceof RecentPaymentDetails_Pending ||
        payment instanceof RecentPaymentDetails_AwaitingInvoice
    )
}
export function signStable(node: LdkNode, bytes: Uint8Array) {
  return UtilMethods.constructor_sign(bytes, node.nodeSecretKey)
}
export function verifyStable(provider: StableProvider, bytes: Uint8Array, signature: string) {
  return UtilMethods.constructor_verify(bytes, signature, hexToBytes(provider.nodeId))
}

export async function sendStableKeysend(
  node: LdkNode,
  provider: StableProvider,
  intent: StableIntent,
  canSend: () => boolean
) {
  const channel = providerChannel(node, provider)
  const amount = BigInt(intent.amountMsat)
  if (
    !channel?.usable ||
    channel.channelId !== intent.channelId ||
    amount > channel.spendableSats * 1000n
  )
    throw new StableSendRejected('Stable channel is unavailable')
  const fields = RecipientOnionFields.constructor_spontaneous_empty().with_custom_tlvs([
    TwoTuple_u64CVec_u8ZZ.constructor_new(
      BigInt(intent.tlv),
      new TextEncoder().encode(intent.payload)
    ),
  ])
  if (!(fields instanceof Result_RecipientOnionFieldsNoneZ_OK))
    throw new StableSendRejected('Invalid custom payment metadata')
  const params = PaymentParameters.constructor_for_keysend(hexToBytes(provider.nodeId), 144, false)
  params.set_max_path_length(1)
  params.set_max_path_count(1)
  const route = RouteParameters.constructor_new(params, amount, Option_u64Z.constructor_some(0n))
  await persistPayment({
    paymentHash: intent.paymentId,
    direction: 'outbound',
    amountMsat: amount,
    status: 'pending',
    feePaidMsat: null,
    createdAt: intent.createdAt,
    failureReason: null,
  })
  const latest = providerChannel(node, provider)
  const backing = BigInt(intent.backingSats)
  const capacityChanged =
    !latest ||
    (intent.kind === 'settlement'
      ? backing + amount / 1000n > latest.receiverSats
      : backing > latest.receiverSats - (amount + 999n) / 1000n)
  if (!canSend() || !latest?.usable || latest.channelId !== intent.channelId || capacityChanged) {
    await updatePaymentStatus(intent.paymentId, 'failed', 0n, 'Channel changed before sending')
    throw new StableSendRejected('Wallet or channel changed before sending; review a fresh quote')
  }
  const result = node.channelManager.send_spontaneous_payment(
    Option_ThirtyTwoBytesZ.constructor_some(hexToBytes(intent.preimage)),
    fields.res,
    hexToBytes(intent.paymentId),
    route,
    Retry.constructor_attempts(0)
  )
  if (!result.is_ok()) {
    await updatePaymentStatus(intent.paymentId, 'failed', 0n, 'Direct-channel payment rejected')
    throw new StableSendRejected('The direct-channel payment was rejected')
  }
  node.peerManager.process_events()
}

/** Copy all bytes before leaving the event callback; no WASM handle crosses an await. */
export function copyStablePaymentEvent(event: LdkEvent): StablePaymentEvent | null {
  if (event instanceof Event_PaymentSent) {
    return {
      kind: 'sent',
      paymentId: bytesToHex(
        event.payment_id instanceof Option_ThirtyTwoBytesZ_Some
          ? event.payment_id.some
          : event.payment_hash
      ),
    }
  }
  if (event instanceof Event_PaymentFailed)
    return { kind: 'failed', paymentId: bytesToHex(event.payment_id) }
  if (!(event instanceof Event_PaymentClaimed)) return null
  const result: StablePaymentEvent = {
    kind: 'received',
    paymentId: bytesToHex(event.payment_hash),
    amountMsat: event.amount_msat,
    records: [],
    channelIds: [],
  }
  const fields = event.onion_fields
  if (fields && (fields as unknown as { ptr?: bigint }).ptr !== 0n) {
    result.records = fields
      .custom_tlvs()
      .map((record) => ({ type: record.get_a(), value: new Uint8Array(record.get_b()) }))
  }
  result.channelIds = (event.htlcs ?? []).map((htlc) => bytesToHex(htlc.get_channel_id().write()))
  return result
}
