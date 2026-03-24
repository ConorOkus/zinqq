import { idbPut, idbGet, idbGetAll, type StoreName } from '../../storage/idb'

const STORE: StoreName = 'ldk_payment_history'

export interface PersistedPayment {
  paymentHash: string
  direction: 'inbound' | 'outbound'
  amountMsat: bigint
  status: 'pending' | 'succeeded' | 'failed'
  feePaidMsat: bigint | null
  createdAt: number // Date.now() unix ms
  failureReason: string | null
}

interface SerializedPayment {
  paymentHash: string
  direction: 'inbound' | 'outbound'
  amountMsat: string
  status: 'pending' | 'succeeded' | 'failed'
  feePaidMsat: string | null
  createdAt: number
  failureReason: string | null
}

export async function persistPayment(payment: PersistedPayment): Promise<void> {
  const serialized: SerializedPayment = {
    paymentHash: payment.paymentHash,
    direction: payment.direction,
    amountMsat: payment.amountMsat.toString(),
    status: payment.status,
    feePaidMsat: payment.feePaidMsat?.toString() ?? null,
    createdAt: payment.createdAt,
    failureReason: payment.failureReason,
  }
  await idbPut(STORE, payment.paymentHash, serialized)
}

export async function updatePaymentStatus(
  paymentHash: string,
  status: 'succeeded' | 'failed',
  feePaidMsat?: bigint | null,
  failureReason?: string
): Promise<void> {
  const raw = await idbGet<SerializedPayment>(STORE, paymentHash)
  if (!raw) return
  const existing = deserializePayment(raw)
  await persistPayment({
    ...existing,
    status,
    feePaidMsat: feePaidMsat ?? existing.feePaidMsat,
    failureReason: failureReason ?? existing.failureReason,
  })
}

function deserializePayment(value: SerializedPayment): PersistedPayment {
  return {
    paymentHash: value.paymentHash,
    direction: value.direction,
    amountMsat: BigInt(value.amountMsat),
    status: value.status,
    feePaidMsat: value.feePaidMsat ? BigInt(value.feePaidMsat) : null,
    createdAt: value.createdAt,
    failureReason: value.failureReason,
  }
}

export async function loadAllPayments(): Promise<Map<string, PersistedPayment>> {
  const raw = await idbGetAll<SerializedPayment>(STORE)
  const result = new Map<string, PersistedPayment>()
  for (const [key, value] of raw) {
    result.set(key, deserializePayment(value))
  }
  return result
}
