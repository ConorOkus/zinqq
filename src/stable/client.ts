import { bytesToHex, hexToBytes } from '../ldk/utils'
import { sha256 } from '@noble/hashes/sha2.js'
import { quoteAllocation, receivedBacking, settlementDecision, usdNumber } from './math'
import {
  decodeProviderMessage,
  envelope,
  requestHash,
  sameCorrelation,
  SETTLEMENT_TLV,
  SETTLEMENT_TTL,
  TRADE_TLV,
  USD_UNITS,
  usdUnits,
} from './protocol'
import { PRICE_MAX_AGE_MS, type PriceQuote } from './price'
import type {
  StableChannel,
  StableIntent,
  StablePaymentEvent,
  StableProvider,
  StableSnapshot,
  StableState,
  StableTradeQuote,
} from './types'

export interface StablePersistence {
  state: StableState
  save: (state: StableState) => Promise<void>
  flush: () => Promise<void>
}
export interface StableClientDeps {
  store: StablePersistence
  provider: StableProvider
  channel: () => StableChannel | null
  canSend: () => boolean
  sign: (bytes: Uint8Array) => string
  verify: (bytes: Uint8Array, signature: string) => boolean
  send: (intent: StableIntent) => Promise<void>
  price: (previous: PriceQuote | null) => Promise<PriceQuote>
  now?: () => number
}
export class StableSendRejected extends Error {}

export class StableClient {
  private tail: Promise<unknown> = Promise.resolve()
  private stopped = false
  private price: PriceQuote | null = null
  private priceQuarantined = false
  private lastSync = 0
  private priceExpiry: ReturnType<typeof setTimeout> | null = null
  private listeners = new Set<() => void>()
  private snapshot: StableSnapshot
  private busy = false
  private preparingPayment = false
  private error: string | null = null
  private readonly now: () => number
  private readonly deps: StableClientDeps
  constructor(deps: StableClientDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.snapshot = this.makeSnapshot()
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = () => this.snapshot
  blocksOrdinaryPayments = () =>
    this.preparingPayment ||
    !!this.deps.store.state.pending ||
    (!!this.deps.store.state.firstReceive?.received &&
      !this.deps.store.state.firstReceive.attempted) ||
    this.deps.store.state.inbox.length > 0
  canPrepareFirstReceive = () => {
    const state = this.deps.store.state
    return !state.position && !state.pending && !state.paused && !state.firstReceive?.received
  }
  private makeSnapshot(): StableSnapshot {
    let channel: StableChannel | null = null
    let channelError: string | null = null
    try {
      channel = this.deps.channel()
    } catch (error) {
      channelError = error instanceof Error ? error.message : 'Provider channel unavailable'
    }
    const state = this.deps.store.state
    const price = this.price
    let status = 'Not enabled'
    if (state.enabled) {
      if (channelError) status = 'Provider channel unavailable'
      else if (state.position && state.position.channelId !== channel?.channelId)
        status = 'Previous stable channel is closed'
      else if (!channel) status = 'Fund a channel with the stability provider'
      else if (!channel.usable) status = 'Provider channel is offline'
      else if (state.pending)
        status =
          state.pending.kind === 'trade'
            ? 'Awaiting provider acknowledgement'
            : 'Settlement payment pending'
      else if (state.inbox.length > 0) status = 'Applying provider update'
      else if (!price || this.priceQuarantined || this.now() - price.observedAt > PRICE_MAX_AGE_MS)
        status = 'Waiting for fresh USD prices'
      else if (!state.position || state.position.targetUsd === 0) status = 'Ready to allocate USD'
      else if (channel.inboundSats === 0n) status = 'Provider collateral is depleted'
      else if (BigInt(state.position.backingSats) > channel.receiverSats)
        status = 'Awaiting provider balance reconciliation'
      else if (state.paused || this.now() - this.lastSync > 120_000 || !this.deps.canSend())
        status = 'Settlement paused'
      else {
        const action = settlementDecision(
          usdUnits(state.position.targetUsd),
          BigInt(state.position.backingSats),
          price.priceCents * 10_000_000n,
          USD_UNITS
        ).action
        status =
          action === 'awaiting-provider'
            ? 'Awaiting provider settlement'
            : action === 'pay'
              ? 'Settlement due'
              : 'Active'
      }
      if (!state.position && !state.pending && state.firstReceive) {
        if (state.firstReceive.attempted) status = 'Dollar conversion needs attention'
        else if (!state.firstReceive.received)
          status = 'Your first Lightning payment will become dollars'
        else
          status = this.error
            ? `Waiting to convert: ${this.error}`
            : 'Converting your first payment to dollars'
      }
    }
    return {
      state,
      price,
      priceFresh:
        !!price && !this.priceQuarantined && this.now() - price.observedAt <= PRICE_MAX_AGE_MS,
      channel,
      status,
      error: this.error ?? channelError ?? state.notice,
      busy: this.busy,
    }
  }
  private publish() {
    this.snapshot = this.makeSnapshot()
    this.listeners.forEach((listener) => listener())
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.stopped) throw new Error('Stable balance client stopped')
      await this.deps.store.flush()
      this.busy = true
      this.publish()
      try {
        const value = await work()
        this.error = null
        return value
      } catch (error) {
        this.error = error instanceof Error ? error.message : 'Stable balance unavailable'
        throw error
      } finally {
        this.busy = false
        this.publish()
      }
    })
    this.tail = result.catch(() => {})
    return result
  }
  private async save(change: Partial<StableState>) {
    if (this.stopped) throw new Error('Stable balance client stopped')
    await this.deps.store.save({
      ...this.deps.store.state,
      ...change,
      revision: this.deps.store.state.revision + 1,
    })
  }
  markSynced() {
    this.lastSync = this.now()
    this.publish()
  }
  refreshStatus = () => {
    if (!this.stopped) this.publish()
  }
  stop() {
    this.stopped = true
    if (this.priceExpiry !== null) clearTimeout(this.priceExpiry)
    this.listeners.clear()
  }
  private readyChannel(): StableChannel {
    const state = this.deps.store.state
    const channel = this.deps.channel()
    if (!state.enabled || state.provider.nodeId !== this.deps.provider.nodeId || !channel?.usable)
      throw new Error('A ready direct channel to the selected provider is required')
    if (state.position && state.position.channelId !== channel.channelId)
      throw new Error(
        'The previous stable channel is closed; resolve its position before allocating again'
      )
    return channel
  }
  private requireSend() {
    if (
      this.stopped ||
      !this.deps.canSend() ||
      this.lastSync === 0 ||
      this.now() < this.lastSync ||
      this.now() - this.lastSync > 120_000
    )
      throw new Error('Wait for a fresh chain sync and an active, backed-up wallet')
  }
  private requirePrice(): PriceQuote {
    if (
      !this.price ||
      this.priceQuarantined ||
      this.now() < this.price.observedAt - 5000 ||
      this.now() - this.price.observedAt > PRICE_MAX_AGE_MS
    )
      throw new Error('Fresh USD market consensus is required')
    return this.price
  }
  enable = () =>
    this.serial(async () => {
      await this.save({ enabled: true, provider: this.deps.provider, notice: null })
    })
  prepareFirstReceive = (paymentHash: string) =>
    this.serial(async () => {
      if (!this.canPrepareFirstReceive()) return
      const first = this.deps.store.state.firstReceive
      await this.save({
        enabled: true,
        provider: this.deps.provider,
        firstReceive: {
          paymentHashes: [...new Set([...(first?.paymentHashes ?? []), paymentHash])],
          received: null,
          attempted: false,
        },
      })
    })
  pause = (paused: boolean) =>
    this.serial(async () => {
      await this.save({ paused })
    })
  clearClosedPosition = () =>
    this.serial(async () => {
      const state = this.deps.store.state
      if (!state.position || this.deps.channel()?.channelId === state.position.channelId)
        throw new Error('Close the previous provider channel first')
      if (state.pending || state.inbox.length)
        throw new Error('Wait for pending stable operations before clearing the position')
      await this.save({
        position: null,
        notice: 'Closed position cleared. Channel proceeds remain bitcoin.',
      })
    })
  refresh = () =>
    this.serial(async () => {
      try {
        this.price = await this.deps.price(this.price)
        this.priceQuarantined = false
        if (this.priceExpiry !== null) clearTimeout(this.priceExpiry)
        this.priceExpiry = setTimeout(
          this.refreshStatus,
          Math.max(1, PRICE_MAX_AGE_MS - (this.now() - this.price.observedAt) + 1)
        )
      } catch (error) {
        this.priceQuarantined = true
        throw error
      }
    })
  quote = (targetCents: bigint): StableTradeQuote => {
    this.requireSend()
    const channel = this.readyChannel()
    const price = this.requirePrice()
    const state = this.deps.store.state
    if (state.pending || state.inbox.length)
      throw new Error('Wait for the previous stable operation to finish')
    const position = state.position
    const allocation = quoteAllocation(
      usdUnits(position?.targetUsd ?? 0),
      BigInt(position?.backingSats ?? '0'),
      targetCents * 10_000_000n,
      price.priceCents * 10_000_000n,
      channel.spendableSats,
      channel.receiverSats,
      USD_UNITS
    )
    if (
      targetCents * 10_000_000n > usdUnits(position?.targetUsd ?? 0) &&
      channel.inboundSats === 0n
    )
      throw new Error('The provider has no inbound liquidity for collateral payments')
    usdUnits(usdNumber(targetCents))
    if (targetCents * 10_000_000n === usdUnits(position?.targetUsd ?? 0))
      throw new Error('Choose a different USD target')
    return {
      ...allocation,
      targetCents,
      baseline: state.revision,
      channelId: channel.channelId,
      price,
    }
  }
  /** Read-only suggestion using the same fee and balance limits as a reviewed trade. */
  quoteMaximum = (): StableTradeQuote => {
    const current = BigInt(Math.round((this.deps.store.state.position?.targetUsd ?? 0) * 100))
    let best = this.quote(current + 1n)
    const channel = this.readyChannel()
    // Keep the acknowledged target when BTC prices move; only newly allocated
    // bitcoin is valued at the current price.
    let low = current + 2n
    let high = current + (channel.receiverSats * best.price.priceCents) / 100_000_000n
    while (low <= high) {
      const mid = (low + high) / 2n
      try {
        best = this.quote(mid)
        low = mid + 1n
      } catch {
        high = mid - 1n
      }
    }
    return best
  }
  private intent(
    kind: StableIntent['kind'],
    channelId: string,
    amountMsat: bigint,
    payload: string,
    tlv: bigint,
    targetUsd: number,
    backingSats: bigint,
    tradeId?: string
  ): StableIntent {
    const preimage = crypto.getRandomValues(new Uint8Array(32))
    const paymentId = bytesToHex(sha256(preimage))
    return {
      kind,
      channelId,
      amountMsat: amountMsat.toString(),
      preimage: bytesToHex(preimage),
      paymentId,
      payload: new TextDecoder().decode(envelope(payload, this.deps.sign)),
      tlv: tlv.toString(),
      targetUsd,
      backingSats: backingSats.toString(),
      createdAt: this.now(),
      sent: false,
      correlation: tradeId ? { tradeId, paymentId, requestHash: requestHash(payload) } : null,
    }
  }
  private async send(intent: StableIntent) {
    this.preparingPayment = true
    try {
      await this.save({
        pending: intent,
        notice: null,
        ...(intent.kind === 'trade' && this.deps.store.state.firstReceive?.received
          ? { firstReceive: { ...this.deps.store.state.firstReceive, attempted: true } }
          : {}),
      })
      try {
        this.requireSend()
      } catch (error) {
        await this.save({ pending: null })
        throw error
      }
      try {
        await this.deps.send(intent)
      } catch (error) {
        if (error instanceof StableSendRejected)
          await this.save({
            pending: null,
            notice: 'Payment was rejected before sending. Refresh the quote and retry.',
          })
        throw error
      }
    } finally {
      this.preparingPayment = false
    }
  }
  commit = (quote: StableTradeQuote) => this.serial(() => this.commitQuote(quote))
  private async commitQuote(quote: StableTradeQuote) {
    const current = this.quote(quote.targetCents)
    if (
      quote.baseline !== current.baseline ||
      quote.channelId !== current.channelId ||
      quote.feeSats !== current.feeSats ||
      quote.backingSats !== current.backingSats ||
      quote.price.observedAt !== current.price.observedAt
    )
      throw new Error('The quote changed. Review a fresh quote')
    const channel = this.readyChannel()
    const targetUsd = usdNumber(quote.targetCents)
    const tradeId = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
    const payload = JSON.stringify({
      type: 'TRADE_V1',
      channel_id: channel.channelId,
      user_channel_id: channel.userChannelId,
      trade_id: tradeId,
      expected_usd: targetUsd,
      quote_price: Number(quote.price.priceCents) / 100,
      ts: Math.floor(this.now() / 1000),
    })
    const fee = quote.feeSats * 1000n
    await this.send(
      this.intent(
        'trade',
        channel.channelId,
        fee > 0n ? fee : 1n,
        payload,
        TRADE_TLV,
        targetUsd,
        quote.backingSats,
        tradeId
      )
    )
  }
  autoConvertFirstReceive = () =>
    this.serial(async () => {
      const state = this.deps.store.state
      const first = state.firstReceive
      if (!first?.received || first.attempted || state.position || state.pending || state.paused)
        return
      this.requireSend()
      const channel = this.readyChannel()
      if (channel.channelId !== first.received.channelId)
        throw new Error('The first receive channel is unavailable')
      const price = this.requirePrice()
      let low = 1n
      let high = (channel.receiverSats * price.priceCents) / 100_000_000n
      let target = 0n
      while (low <= high) {
        const mid = (low + high) / 2n
        try {
          quoteAllocation(
            0n,
            0n,
            mid,
            price.priceCents,
            channel.spendableSats,
            channel.receiverSats
          )
          target = mid
          low = mid + 1n
        } catch {
          high = mid - 1n
        }
      }
      if (target === 0n) throw new Error('The first payment is too small to allocate dollars')
      await this.commitQuote(this.quote(target))
    })
  /** Called only after a tracked splice locks on the same logical provider channel. */
  rebindSplicedChannel = (oldChannelId: string, newChannelId: string) =>
    this.serial(async () => {
      const state = this.deps.store.state
      if (state.pending || state.inbox.length)
        throw new Error('Wait for provider updates before completing channel funding')
      if (state.position?.channelId === newChannelId) return
      if (state.position && state.position.channelId !== oldChannelId)
        throw new Error('Dollar position belongs to a different channel')
      if (state.position)
        await this.save({ position: { ...state.position, channelId: newChannelId } })
    })
  allocateAll = (beforeSend: () => Promise<void>) =>
    this.serial(async () => {
      const state = this.deps.store.state
      if (state.paused || state.pending || state.inbox.length)
        throw new Error('Wait for dollar balance updates')
      const quote = this.quoteMaximum()
      await beforeSend()
      await this.commitQuote(quote)
    })
  tick = () =>
    this.serial(async () => {
      await this.applyInbox()
      const state = this.deps.store.state
      if (
        !state.enabled ||
        state.paused ||
        !state.position ||
        state.pending ||
        state.position.targetUsd === 0
      )
        return
      this.requireSend()
      const channel = this.readyChannel()
      const price = this.requirePrice()
      const position = state.position
      const backing = BigInt(position.backingSats)
      if (backing > channel.receiverSats) return
      if (this.now() - position.lastSettlementAt < 120_000) return
      const decision = settlementDecision(
        usdUnits(position.targetUsd),
        backing,
        price.priceCents * 10_000_000n,
        USD_UNITS
      )
      if (decision.action !== 'pay' || decision.sats === 0n) return
      if (decision.sats > channel.spendableSats)
        throw new Error('Provider channel has insufficient settlement capacity')
      const createdAt = Math.floor(this.now() / 1000)
      if (!Number.isSafeInteger(Number(decision.sats * 1000n)))
        throw new Error('Settlement amount is too large')
      const payload = JSON.stringify({
        type: 'STABILITY_PAYMENT_V1',
        settlement_id: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
        channel_id: channel.channelId,
        amount_msat: Number(decision.sats * 1000n),
        direction: 'user_to_lsp',
        expected_usd: position.targetUsd,
        created_at: createdAt,
        expires_at: createdAt + SETTLEMENT_TTL,
      })
      await this.send(
        this.intent(
          'settlement',
          channel.channelId,
          decision.sats * 1000n,
          payload,
          SETTLEMENT_TLV,
          position.targetUsd,
          backing - decision.sats
        )
      )
    })
  handles(event: StablePaymentEvent): boolean {
    const state = this.deps.store.state
    return (
      state.enabled &&
      (event.kind === 'received'
        ? (!state.firstReceive?.received &&
            !!state.firstReceive?.paymentHashes.includes(event.paymentId)) ||
          event.records.some(
            (record) => record.type === TRADE_TLV || record.type === SETTLEMENT_TLV
          )
        : state.pending?.paymentId === event.paymentId)
    )
  }
  private async applyPayment(event: StablePaymentEvent, receivedAt = this.now()) {
    const state = this.deps.store.state
    if (!this.handles(event)) return
    if (event.kind !== 'received') {
      const intent = state.pending!
      if (event.kind === 'failed') {
        await this.save({
          pending: null,
          notice: 'The stable-channel payment failed. Review a fresh quote before retrying.',
        })
        return
      }
      if (intent.kind === 'trade') {
        await this.save({ pending: { ...intent, sent: true } })
        return
      }
      if (!state.position) throw new Error('Missing settlement position')
      await this.save({
        pending: null,
        position: {
          ...state.position,
          backingSats: intent.backingSats,
          lastSettlementAt: this.now(),
        },
        notice: null,
      })
      return
    }
    if (state.position?.receipts[event.paymentId]) return
    const channel = this.deps.channel()
    if (!channel || !event.channelIds.includes(channel.channelId)) return
    for (const record of event.records) {
      if (record.type !== TRADE_TLV && record.type !== SETTLEMENT_TLV) continue
      let message
      try {
        message = decodeProviderMessage(record.value, this.deps.verify)
      } catch {
        continue
      }
      if (
        message.channelId !== channel.channelId ||
        (state.position && state.position.channelId !== channel.channelId)
      )
        continue
      if (message.kind === 'rejected') {
        if (
          record.type !== TRADE_TLV ||
          event.amountMsat !== 1n ||
          !state.pending?.correlation ||
          !sameCorrelation(state.pending.correlation, message.correlation)
        )
          continue
        await this.save({
          pending: null,
          notice: `Provider rejected the trade (${message.reason.replaceAll('_', ' ')}). Refresh prices before retrying.`,
        })
        return
      }
      if (message.kind === 'sync') {
        if (
          record.type !== TRADE_TLV ||
          event.amountMsat !== 1n ||
          message.version <= BigInt(state.position?.syncVersion ?? '0')
        )
          continue
        let backing: bigint
        if (message.correlation) {
          const intent = state.pending
          if (
            intent?.kind !== 'trade' ||
            !intent.correlation ||
            !sameCorrelation(intent.correlation, message.correlation) ||
            Math.abs(intent.targetUsd - message.expectedUsd) > 1e-9
          )
            continue
          backing = BigInt(intent.backingSats)
        } else {
          if (!state.position || state.pending || message.expectedUsd > state.position.targetUsd)
            continue
          const price = this.requirePrice()
          const oldBacking = BigInt(state.position.backingSats)
          if (message.expectedUsd < state.position.targetUsd && channel.receiverSats >= oldBacking)
            continue
          backing =
            BigInt(state.position.backingSats) +
            (usdUnits(message.expectedUsd) * 100_000_000n) / (price.priceCents * 10_000_000n) -
            (usdUnits(state.position.targetUsd) * 100_000_000n) / (price.priceCents * 10_000_000n)
          if (message.expectedUsd === 0) backing = 0n
          const missing = oldBacking > channel.receiverSats ? oldBacking - channel.receiverSats : 0n
          if (message.expectedUsd < state.position.targetUsd) {
            const discrepancy =
              backing > channel.receiverSats
                ? backing - channel.receiverSats
                : channel.receiverSats - backing
            if (discrepancy > missing / 100n + 2n) continue
            if (message.expectedUsd > 0) backing = channel.receiverSats
          }
        }
        if (backing < 0n || backing > channel.receiverSats)
          throw new Error('Waiting for settled channel capacity before accepting the allocation')
        await this.save({
          position: {
            channelId: channel.channelId,
            targetUsd: message.expectedUsd,
            backingSats: backing.toString(),
            syncVersion: message.version.toString(),
            lastSettlementAt: state.position?.lastSettlementAt ?? 0,
            receipts: { ...state.position?.receipts, [event.paymentId]: `sync:${message.version}` },
          },
          pending: null,
          notice: null,
        })
        return
      }
      const position = state.position
      const nowSecs = Math.floor(receivedAt / 1000)
      if (
        record.type !== SETTLEMENT_TLV ||
        !position ||
        state.pending?.kind === 'trade' ||
        message.direction !== 'lsp_to_user' ||
        message.amountMsat !== event.amountMsat ||
        Math.abs(message.expectedUsd - position.targetUsd) > 1e-9 ||
        message.createdAt > nowSecs + 60 ||
        nowSecs > message.expiresAt + 60 ||
        Object.values(position.receipts).includes(message.settlementId)
      )
        continue
      const price = this.requirePrice()
      const backing = receivedBacking(
        BigInt(position.backingSats),
        usdUnits(position.targetUsd),
        price.priceCents * 10_000_000n,
        event.amountMsat / 1000n,
        channel.receiverSats
      )
      await this.save({
        position: {
          ...position,
          backingSats: backing.toString(),
          lastSettlementAt: this.now(),
          receipts: { ...position.receipts, [event.paymentId]: message.settlementId },
        },
      })
      return
    }
  }
  private async applyInbox() {
    while (!this.stopped && this.deps.store.state.inbox.length) {
      const state = this.deps.store.state
      if (state.pending?.kind === 'settlement') return
      let index = 0
      if (state.pending?.kind === 'trade') {
        index = state.inbox.findIndex((entry) =>
          entry.records.some((record) => {
            try {
              const message = decodeProviderMessage(hexToBytes(record.value), this.deps.verify)
              return (
                (message.kind === 'rejected' || message.kind === 'sync') &&
                message.correlation &&
                state.pending?.correlation &&
                sameCorrelation(state.pending.correlation, message.correlation)
              )
            } catch {
              return false
            }
          })
        )
        if (index === -1) return
      }
      const entry = state.inbox[index]!
      await this.applyPayment(
        {
          kind: 'received',
          paymentId: entry.paymentId,
          amountMsat: BigInt(entry.amountMsat),
          channelIds: entry.channelIds,
          records: entry.records.map((record) => ({
            type: BigInt(record.type),
            value: hexToBytes(record.value),
          })),
        },
        entry.receivedAt
      )
      await this.save({
        inbox: this.deps.store.state.inbox.filter((value) => value.paymentId !== entry.paymentId),
      })
    }
  }
  processInbox = () => this.serial(() => this.applyInbox())
  onPayment = (event: StablePaymentEvent) =>
    this.serial(async () => {
      if (event.kind !== 'received') {
        await this.applyPayment(event)
        return
      }
      const state = this.deps.store.state
      const first = state.firstReceive
      if (first && !first.received && first.paymentHashes.includes(event.paymentId)) {
        const channel = this.deps.channel()
        if (!channel || !event.channelIds.includes(channel.channelId) || event.amountMsat < 1000n)
          return
        // Persist the actual claimed amount before LDK acknowledges the event.
        // Price lookup and the fee payment run later, outside the event handler.
        await this.save({
          firstReceive: {
            ...first,
            received: {
              paymentId: event.paymentId,
              channelId: channel.channelId,
              amountSats: (event.amountMsat / 1000n).toString(),
            },
          },
        })
        return
      }
      if (
        !this.handles(event) ||
        state.position?.receipts[event.paymentId] ||
        state.inbox.some((entry) => entry.paymentId === event.paymentId)
      )
        return
      const channel = this.deps.channel()
      if (!channel || !event.channelIds.includes(channel.channelId)) return
      const records = event.records.filter((record) => {
        if (record.type !== TRADE_TLV && record.type !== SETTLEMENT_TLV) return false
        try {
          return (
            decodeProviderMessage(record.value, this.deps.verify).channelId === channel.channelId
          )
        } catch {
          return false
        }
      })
      if (!records.length) return
      // Receipt is durable before LDK drops its event. Oracle outages and an outgoing
      // settlement must not block later Lightning events behind this received payment.
      await this.save({
        inbox: [
          ...state.inbox,
          {
            paymentId: event.paymentId,
            amountMsat: event.amountMsat.toString(),
            channelIds: event.channelIds,
            receivedAt: this.now(),
            records: records.map((record) => ({
              type: record.type.toString(),
              value: bytesToHex(record.value),
            })),
          },
        ],
      })
    })
}
