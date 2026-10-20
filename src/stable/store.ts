import { idbGet, idbPut } from '../storage/idb'
import type { VssClient } from '../ldk/storage/vss-client'
import { HEX_ID, usdUnits } from './protocol'
import type { StableProvider, StableState } from './types'

export const STABLE_VSS_KEY = 'stable_channels_v1'
const STORE = 'ldk_stable_channels'
export function initialStableState(provider: StableProvider): StableState {
  return {
    schema: 1,
    revision: 0,
    enabled: false,
    paused: false,
    provider,
    position: null,
    pending: null,
    notice: null,
    inbox: [],
  }
}

function validateState(raw: unknown): StableState {
  const state = raw as StableState | null
  const digits = (value: unknown) => typeof value === 'string' && /^\d{1,25}$/.test(value)
  if (
    !state ||
    state.schema !== 1 ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    typeof state.enabled !== 'boolean' ||
    typeof state.paused !== 'boolean' ||
    !state.provider ||
    !/^(02|03)[0-9a-f]{64}$/.test(state.provider.nodeId) ||
    typeof state.provider.host !== 'string' ||
    !/^[a-zA-Z0-9._-]+$/.test(state.provider.host) ||
    !Number.isInteger(state.provider.port) ||
    state.provider.port < 1 ||
    state.provider.port > 65535 ||
    (state.notice !== null && typeof state.notice !== 'string')
  )
    throw new Error('Invalid stable balance backup')
  if (state.firstReceive !== undefined) {
    const first = state.firstReceive
    if (
      !first ||
      !Array.isArray(first.paymentHashes) ||
      !first.paymentHashes.length ||
      !first.paymentHashes.every((hash) => typeof hash === 'string' && HEX_ID.test(hash)) ||
      typeof first.attempted !== 'boolean' ||
      (first.attempted && !first.received) ||
      (first.received !== null &&
        (!first.received ||
          !first.paymentHashes.includes(first.received.paymentId) ||
          !HEX_ID.test(first.received.channelId) ||
          !digits(first.received.amountSats) ||
          BigInt(first.received.amountSats) <= 0n))
    )
      throw new Error('Invalid first receive conversion backup')
  }
  if (state.position) {
    const p = state.position
    usdUnits(p.targetUsd)
    if (
      !HEX_ID.test(p.channelId) ||
      !digits(p.backingSats) ||
      !digits(p.syncVersion) ||
      !Number.isSafeInteger(p.lastSettlementAt) ||
      p.lastSettlementAt < 0 ||
      !p.receipts ||
      typeof p.receipts !== 'object' ||
      !Object.entries(p.receipts).every(
        ([key, value]) => HEX_ID.test(key) && typeof value === 'string'
      )
    )
      throw new Error('Invalid stable position backup')
  }
  if (state.pending) {
    const p = state.pending
    usdUnits(p.targetUsd)
    if (
      !['trade', 'settlement'].includes(p.kind) ||
      !HEX_ID.test(p.paymentId) ||
      !HEX_ID.test(p.preimage) ||
      !HEX_ID.test(p.channelId) ||
      !digits(p.amountMsat) ||
      !digits(p.backingSats) ||
      !digits(p.tlv) ||
      typeof p.payload !== 'string' ||
      p.payload.length > 8192 ||
      typeof p.sent !== 'boolean' ||
      !Number.isSafeInteger(p.createdAt) ||
      p.createdAt < 0 ||
      (p.kind === 'trade' &&
        (!p.correlation ||
          !Object.values(p.correlation).every((v) => typeof v === 'string' && HEX_ID.test(v))))
    )
      throw new Error('Invalid stable operation backup')
  }
  if (
    !Array.isArray(state.inbox) ||
    !state.inbox.every(
      (entry) =>
        entry &&
        HEX_ID.test(entry.paymentId) &&
        digits(entry.amountMsat) &&
        Number.isSafeInteger(entry.receivedAt) &&
        entry.receivedAt >= 0 &&
        Array.isArray(entry.channelIds) &&
        entry.channelIds.every((channelId) => HEX_ID.test(channelId)) &&
        Array.isArray(entry.records) &&
        entry.records.every(
          (record) =>
            digits(record.type) &&
            typeof record.value === 'string' &&
            record.value.length <= 16_384 &&
            /^(?:[0-9a-f]{2})+$/.test(record.value)
        )
    )
  )
    throw new Error('Invalid stable receipt backup')
  return state
}

export class StableStore {
  private version = 0
  private pendingLocal: StableState | null = null
  state: StableState
  private readonly vss: VssClient | null
  constructor(provider: StableProvider, vss: VssClient | null) {
    this.vss = vss
    this.state = initialStableState(provider)
  }
  async load(): Promise<void> {
    const local = await idbGet<unknown>(STORE, 'primary')
    if (local !== undefined) this.state = validateState(local)
    if (this.vss) {
      const remote = await this.vss.getObject(STABLE_VSS_KEY)
      this.version = remote?.version ?? 0
      if (remote) {
        this.state = validateState(JSON.parse(new TextDecoder().decode(remote.value)) as unknown)
        await idbPut(STORE, 'primary', this.state)
      }
    }
  }
  async flush(): Promise<void> {
    if (!this.pendingLocal) return
    await idbPut(STORE, 'primary', this.pendingLocal)
    this.pendingLocal = null
  }
  async save(next: StableState): Promise<void> {
    await this.flush()
    validateState(next)
    // Never retry a conflicting snapshot by overwriting a newer owner's state.
    if (this.vss)
      this.version = await this.vss.putObject(
        STABLE_VSS_KEY,
        new TextEncoder().encode(JSON.stringify(next)),
        this.version
      )
    this.state = next
    this.pendingLocal = next
    await this.flush()
  }
}
