import {
  ChannelId,
  FundingTxInput,
  SpliceContribution,
  Option_CVec_u8ZZ,
  Option_CVec_u8ZZ_Some,
  Option_u32Z,
  Option_u16Z_Some,
  Result_FundingTxInputNoneZ_OK,
  Result_NoneAPIErrorZ_Err,
  APIError_APIMisuseError,
  Event_FundingTransactionReadyForSigning,
  Event_SplicePending,
  Event_SpliceFailed,
  Event_ChannelReady,
  type Event as LdkEvent,
} from 'lightningdevkit'
import { Transaction, UnconfirmedTx, type Wallet } from '@bitcoindevkit/bdk-wallet-web'
import { sha256 } from '@noble/hashes/sha2.js'
import type { LdkNode } from '../ldk/init'
import type { VssClient } from '../ldk/storage/vss-client'
import { bytesToHex, hexToBytes, txidBytesToHex } from '../ldk/utils'
import { idbGet, idbPut } from '../storage/idb'
import { putChangeset } from '../onchain/storage/changeset'
import { getFeeRate } from '../shared/fee-cache'
import { beginWalletSpend } from '../onchain/spend-lock'
import { recordFundingTxo } from '../ldk/close-records/store'
import {
  ANCHOR_RESERVE_SATS,
  MAX_FEE_SATS,
  MIN_FEE_RATE_SAT_VB,
  ONCHAIN_CONFIG,
} from '../onchain/config'
import { signSpliceFunding, type SpliceCoin, type SpliceFunding } from './splice-bitcoin'

const STORE = 'ldk_stable_channels'
const KEY = 'splice'
const VSS_KEY = 'stable_splice_v1'
const reserved = new Set<string>()
export const isSpliceInputReserved = (outpoint: string) => reserved.has(outpoint)
export interface SpliceQuote extends SpliceFunding {
  id: string
  channelId: string
  userChannelId: string
  providerId: string
  feeRate: number
  expiresAt: number
}
export interface SpliceState {
  schema: 1
  quote: SpliceQuote
  status: 'prepared' | 'negotiating' | 'signed' | 'pending' | 'complete' | 'failed'
  signedTx?: string
  unsignedHash?: string
  newFundingOutpoint?: string
  newChannelId?: string
  conversion: 'waiting' | 'attempted' | 'done'
  error: string | null
}
export function splicePending(state: SpliceState | null): boolean {
  return !!state && state.status !== 'complete' && state.status !== 'failed'
}
function validate(raw: unknown): SpliceState {
  const state = raw as SpliceState
  const q = state?.quote
  const hex = (v: unknown) => typeof v === 'string' && /^(?:[0-9a-f]{2})+$/.test(v)
  const id = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
  const sats = (v: unknown) => typeof v === 'string' && /^\d{1,16}$/.test(v)
  const outpoint = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}:\d{1,10}$/.test(v)
  if (
    !state ||
    state.schema !== 1 ||
    !q ||
    !id(q.id) ||
    !id(q.channelId) ||
    !/^(02|03)[0-9a-f]{64}$/.test(q.providerId) ||
    !/^\d{1,39}$/.test(q.userChannelId) ||
    !sats(q.amountSats) ||
    BigInt(q.amountSats) <= 0n ||
    !sats(q.maxFeeSats) ||
    BigInt(q.maxFeeSats) > MAX_FEE_SATS ||
    !sats(q.channelValueSats) ||
    !outpoint(q.fundingOutpoint) ||
    !hex(q.fundingScript) ||
    !hex(q.changeScript) ||
    !Number.isFinite(q.feeRate) ||
    q.feeRate < Number(MIN_FEE_RATE_SAT_VB) ||
    !Number.isSafeInteger(q.expiresAt) ||
    !Array.isArray(q.inputs) ||
    !q.inputs.length ||
    q.inputs.length > 100 ||
    !q.inputs.every(
      (c) =>
        outpoint(c.outpoint) &&
        sats(c.value) &&
        hex(c.previousTx) &&
        c.previousTx.length < 2_000_000
    ) ||
    !['prepared', 'negotiating', 'signed', 'pending', 'complete', 'failed'].includes(
      state.status
    ) ||
    !['waiting', 'attempted', 'done'].includes(state.conversion) ||
    (state.error !== null && typeof state.error !== 'string') ||
    (state.signedTx !== undefined && !hex(state.signedTx)) ||
    (state.unsignedHash !== undefined && !id(state.unsignedHash)) ||
    (state.newFundingOutpoint !== undefined && !outpoint(state.newFundingOutpoint)) ||
    (state.newChannelId !== undefined && !id(state.newChannelId))
  )
    throw new Error('Invalid channel funding backup')
  return state
}
function updateReservations(state: SpliceState | null) {
  reserved.clear()
  if (splicePending(state)) state!.quote.inputs.forEach((c) => reserved.add(c.outpoint))
}
export async function loadSpliceReservations(): Promise<void> {
  const raw = await idbGet<unknown>(STORE, KEY)
  updateReservations(raw === undefined ? null : validate(raw))
}
export async function assertNoPendingSplice(): Promise<void> {
  const raw = await idbGet<unknown>(STORE, KEY)
  if (raw !== undefined && splicePending(validate(raw)))
    throw new Error(
      'Wait for adding funds to the channel to finish before spending on-chain bitcoin'
    )
}
export type SpliceEvent =
  | {
      kind: 'sign'
      key: string
      userChannelId: string
      providerId: string
      channelId: string
      unsigned: Uint8Array
    }
  | { kind: 'pending'; key: string; userChannelId: string; providerId: string; outpoint: string }
  | { kind: 'failed'; key: string; userChannelId: string; providerId: string; inputs: string[] }
  | { kind: 'ready'; key: string; userChannelId: string; providerId: string; channelId: string }
export function copySpliceEvent(event: LdkEvent): SpliceEvent | null {
  if (
    !(event instanceof Event_FundingTransactionReadyForSigning) &&
    !(event instanceof Event_SplicePending) &&
    !(event instanceof Event_SpliceFailed) &&
    !(event instanceof Event_ChannelReady)
  )
    return null
  const channelId = bytesToHex(event.channel_id.write())
  const common = {
    userChannelId: event.user_channel_id.toString(),
    providerId: bytesToHex(event.counterparty_node_id),
  }
  if (event instanceof Event_FundingTransactionReadyForSigning) {
    const unsigned = new Uint8Array(event.unsigned_transaction)
    return {
      ...common,
      kind: 'sign',
      channelId,
      unsigned,
      key: `splice-sign:${bytesToHex(sha256(unsigned))}`,
    }
  }
  if (event instanceof Event_SplicePending) {
    const point = event.new_funding_txo
    const outpoint = `${txidBytesToHex(point.get_txid())}:${point.get_index()}`
    return { ...common, kind: 'pending', outpoint, key: `splice-pending:${outpoint}` }
  }
  if (event instanceof Event_SpliceFailed)
    return {
      ...common,
      kind: 'failed',
      inputs: event.contributed_inputs.map(
        (p) => `${txidBytesToHex(p.get_txid())}:${p.get_index()}`
      ),
      key: `splice-failed:${channelId}`,
    }
  return { ...common, kind: 'ready', channelId, key: `splice-ready:${channelId}` }
}

interface Dependencies {
  node: LdkNode
  wallet: Wallet
  providerId: string
  vss: VssClient | null
  alive(): boolean
  canStart(): boolean
  persistManager(): Promise<void>
  rebind(oldChannelId: string, newChannelId: string): Promise<void>
  allocateAll(beforeSend: () => Promise<void>): Promise<void>
}

export class SpliceController {
  state: SpliceState | null = null
  error: string | null = null
  private version = 0
  private tail: Promise<unknown> = Promise.resolve()
  private stopped = false
  private reviewedQuote: string | null = null
  private submittedHash: string | null = null
  private listeners = new Set<() => void>()
  private readonly deps: Dependencies
  constructor(deps: Dependencies) {
    this.deps = deps
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  private publish() {
    this.listeners.forEach((fn) => fn())
  }
  stop() {
    this.stopped = true
    this.listeners.clear()
  }
  private assertAlive() {
    if (this.stopped || !this.deps.alive()) throw new Error('Wallet stopped')
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      this.assertAlive()
      try {
        const value = await work()
        this.error = null
        this.publish()
        return value
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e)
        this.publish()
        throw e
      }
    })
    this.tail = result.catch(() => {})
    return result
  }
  async load() {
    const local = await idbGet<unknown>(STORE, KEY)
    this.assertAlive()
    if (local !== undefined) this.state = validate(local)
    if (this.deps.vss) {
      const remote = await this.deps.vss.getObject(VSS_KEY)
      this.assertAlive()
      this.version = remote?.version ?? 0
      if (remote) {
        this.state = validate(JSON.parse(new TextDecoder().decode(remote.value)) as unknown)
        await idbPut(STORE, KEY, this.state)
      }
    }
    updateReservations(this.state)
  }
  private async save(state: SpliceState) {
    this.assertAlive()
    validate(state)
    if (this.deps.vss)
      this.version = await this.deps.vss.putObject(
        VSS_KEY,
        new TextEncoder().encode(JSON.stringify(state)),
        this.version
      )
    this.assertAlive()
    // Set the read model before IDB so a local write failure still blocks further signing.
    this.state = state
    updateReservations(state)
    await idbPut(STORE, KEY, state)
    this.publish()
  }
  private channel() {
    const channels = this.deps.node.channelManager
      .list_channels()
      .filter((c) => bytesToHex(c.get_counterparty().get_node_id()) === this.deps.providerId)
    if (channels.length !== 1)
      throw new Error('One channel with the stability provider is required')
    return channels[0]!
  }
  quote = (amount: bigint) => this.createQuote(amount)
  quoteMaximum = () => this.createQuote(null)
  private createQuote = (amount: bigint | null) =>
    this.serial(async (): Promise<SpliceQuote> => {
      if (splicePending(this.state) || !this.deps.canStart())
        throw new Error('Wait for pending wallet operations to finish')
      if (amount !== null && amount < 1000n)
        throw new Error('Add at least 1,000 sats to the channel')
      const feeRate = Math.max(Number(MIN_FEE_RATE_SAT_VB), Math.ceil(await getFeeRate(6)))
      const channel = this.channel()
      if (!channel.get_is_usable() || !channel.get_is_channel_ready())
        throw new Error('Connect to the provider first')
      if (channel.get_pending_inbound_htlcs().length || channel.get_pending_outbound_htlcs().length)
        throw new Error('Wait for Lightning payments to finish before adding funds')
      const peer = this.deps.node.peerManager
        .list_peers()
        .find((p) => bytesToHex(p.get_counterparty_node_id()) === this.deps.providerId)
      if (!peer?.get_init_features().supports_splicing_production())
        throw new Error('The provider does not support production splicing')
      const point = channel.get_funding_txo()
      const script = channel.get_funding_redeem_script()
      if (
        !point ||
        (point as unknown as { ptr: bigint }).ptr === 0n ||
        !(script instanceof Option_CVec_u8ZZ_Some)
      )
        throw new Error('Channel funding details are unavailable')
      const inputs: SpliceCoin[] = []
      const coins = this.deps.wallet
        .list_unspent()
        .flatMap((c) => {
          const wtx = this.deps.wallet.get_tx(c.outpoint.txid)
          const spk = c.txout.script_pubkey.as_bytes()
          if (
            !wtx?.chain_position.is_confirmed ||
            spk.length !== 22 ||
            spk[0] !== 0 ||
            spk[1] !== 20 ||
            reserved.has(c.outpoint.toString())
          )
            return []
          return [
            {
              outpoint: c.outpoint.toString(),
              value: c.txout.value.to_sat().toString(),
              previousTx: bytesToHex(wtx.tx.to_bytes()),
            },
          ]
        })
        .sort((a, b) => (BigInt(a.value) > BigInt(b.value) ? -1 : 1))
      const total = coins.reduce((sum, c) => sum + BigInt(c.value), 0n)
      if (amount === null) {
        // Consider each largest-first prefix: tiny inputs can cost more in fees
        // than they contribute, and the reserve can also remain in unspent coins.
        let maximum = 0n,
          prefixValue = 0n
        for (let count = 1; count <= Math.min(coins.length, 100); count++) {
          prefixValue += BigInt(coins[count - 1]!.value)
          const prefixFee = BigInt(feeRate) * (220n + 69n * BigInt(count))
          if (prefixFee > MAX_FEE_SATS) break
          const funded = prefixValue - prefixFee
          const afterReserve = total - prefixFee - ANCHOR_RESERVE_SATS
          const candidate = funded < afterReserve ? funded : afterReserve
          if (candidate > maximum) maximum = candidate
        }
        amount = maximum
        if (amount < 1000n)
          throw new Error(
            'Not enough confirmed on-chain bitcoin to add 1,000 sats after the mining fee and 10,000-sat reserve'
          )
      }
      let selected = 0n,
        fee = 0n
      for (const coin of coins) {
        inputs.push(coin)
        selected += BigInt(coin.value)
        fee = BigInt(feeRate) * (220n + 69n * BigInt(inputs.length))
        if (selected >= amount + fee && total - amount - fee >= ANCHOR_RESERVE_SATS) break
      }
      if (
        !inputs.length ||
        inputs.length > 100 ||
        selected < amount + fee ||
        total - amount - fee < ANCHOR_RESERVE_SATS
      )
        throw new Error(
          'Not enough confirmed on-chain bitcoin after the mining fee and 10,000-sat reserve'
        )
      if (fee > MAX_FEE_SATS) throw new Error('Mining fee exceeds the wallet fee limit')
      const change = this.deps.wallet
        .next_unused_address('internal')
        .address.script_pubkey.as_bytes()
      const staged = this.deps.wallet.take_staged()
      const quote: SpliceQuote = {
        id: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
        channelId: bytesToHex(channel.get_channel_id().write()),
        userChannelId: channel.get_user_channel_id().toString(),
        providerId: this.deps.providerId,
        amountSats: amount.toString(),
        feeRate,
        maxFeeSats: fee.toString(),
        expiresAt: Date.now() + 120000,
        inputs,
        fundingOutpoint: `${txidBytesToHex(point.get_txid())}:${point.get_index()}`,
        channelValueSats: channel.get_channel_value_satoshis().toString(),
        fundingScript: `0020${bytesToHex(sha256(script.some))}`,
        changeScript: bytesToHex(change),
      }
      if (staged && !staged.is_empty()) await putChangeset(staged.to_json())
      this.reviewedQuote = JSON.stringify(quote)
      return quote
    })
  commit = (quote: SpliceQuote) =>
    this.serial(async () => {
      const releaseSpend = beginWalletSpend()
      try {
        validate({ schema: 1, quote, status: 'prepared', conversion: 'waiting', error: null })
        if (JSON.stringify(quote) !== this.reviewedQuote)
          throw new Error('Review this funding amount and mining fee first')
        if (quote.expiresAt < Date.now() || splicePending(this.state) || !this.deps.canStart())
          throw new Error('Review a fresh funding quote')
        const ch = this.channel()
        const point = ch.get_funding_txo()
        if (!point || (point as unknown as { ptr: bigint }).ptr === 0n)
          throw new Error('Channel funding changed; review again')
        if (
          bytesToHex(ch.get_channel_id().write()) !== quote.channelId ||
          quote.providerId !== this.deps.providerId ||
          ch.get_user_channel_id().toString() !== quote.userChannelId ||
          ch.get_channel_value_satoshis().toString() !== quote.channelValueSats ||
          `${txidBytesToHex(point.get_txid())}:${point.get_index()}` !== quote.fundingOutpoint ||
          !ch.get_is_usable()
        )
          throw new Error('Channel changed; review again')
        const unspent = new Set(this.deps.wallet.list_unspent().map((c) => c.outpoint.toString()))
        if (quote.inputs.some((c) => !unspent.has(c.outpoint)))
          throw new Error('On-chain funds changed; review again')
        for (const coin of quote.inputs) {
          const [txid, vout] = coin.outpoint.split(':')
          const response = await fetch(`${ONCHAIN_CONFIG.esploraUrl}/tx/${txid}/outspend/${vout}`, {
            signal: AbortSignal.timeout(15000),
          })
          if (!response.ok) throw new Error('Could not verify that the on-chain funds are unspent')
          const status = (await response.json()) as { spent?: unknown }
          if (status.spent !== false)
            throw new Error('On-chain funds changed; refresh the wallet and review again')
        }
        const inputs = quote.inputs.map((c) => {
          const result = FundingTxInput.constructor_new_p2wpkh(
            hexToBytes(c.previousTx),
            Number(c.outpoint.split(':')[1])
          )
          if (!(result instanceof Result_FundingTxInputNoneZ_OK))
            throw new Error('Cannot contribute this on-chain input')
          return result.res
        })
        await this.save({
          schema: 1,
          quote,
          status: 'prepared',
          conversion: 'waiting',
          error: null,
        })
        this.assertAlive()
        const result = this.deps.node.channelManager.splice_channel(
          ChannelId.constructor_from_bytes(hexToBytes(quote.channelId)),
          hexToBytes(quote.providerId),
          SpliceContribution.constructor_splice_in(
            BigInt(quote.amountSats),
            inputs,
            Option_CVec_u8ZZ.constructor_some(hexToBytes(quote.changeScript))
          ),
          quote.feeRate * 250,
          Option_u32Z.constructor_none()
        )
        if (!result.is_ok()) {
          await this.save({
            ...this.state!,
            status: 'failed',
            error: 'The provider channel rejected the splice request',
          })
          throw new Error('The channel could not start adding funds')
        }
        await this.save({ ...this.state!, status: 'negotiating' })
        await this.deps.persistManager()
        this.deps.node.peerManager.process_events()
      } finally {
        releaseSpend()
      }
    })
  cancelUnsigned = () =>
    this.serial(async () => {
      const state = this.state
      if (!state || !splicePending(state) || state.signedTx)
        throw new Error(
          'Funding signatures have already been prepared; wait for the channel result'
        )
      // No wallet signature was ever released: stopping negotiation cannot spend
      // these inputs. Once signed, only LDK's explicit release can unlock them.
      this.deps.node.peerManager.disconnect_by_node_id(hexToBytes(state.quote.providerId))
      await this.deps.persistManager()
      await this.save({
        ...state,
        status: 'failed',
        error: 'Funding request cancelled. No on-chain inputs were signed.',
      })
    })
  handle = (event: SpliceEvent) =>
    this.serial(async () => {
      const state = this.state
      if (!state || !splicePending(state)) {
        if (
          state?.status === 'failed' &&
          !state.signedTx &&
          event.providerId === state.quote.providerId &&
          event.userChannelId === state.quote.userChannelId
        )
          return
        if (
          event.kind === 'sign' &&
          !(
            state?.status === 'complete' &&
            state.unsignedHash === bytesToHex(sha256(event.unsigned))
          )
        )
          throw new Error('No approved splice exists for this signing request')
        return
      }
      const q = state.quote
      if (event.userChannelId !== q.userChannelId || event.providerId !== q.providerId) {
        if (event.kind === 'sign')
          throw new Error('Splice signing request belongs to another channel')
        return
      }
      if (event.kind === 'sign') {
        const hash = bytesToHex(sha256(event.unsigned))
        if (state.unsignedHash && state.unsignedHash !== hash)
          throw new Error('Splice transaction changed after signing')
        let signed = state.signedTx
        if (!signed) {
          const tx = Transaction.from_bytes(event.unsigned)
          const previous: Uint8Array[] = []
          for (const input of tx.input) {
            const own = q.inputs.find((c) => c.outpoint === input.previous_output.toString())
            if (own) previous.push(hexToBytes(own.previousTx))
            else {
              const response = await fetch(
                `${ONCHAIN_CONFIG.esploraUrl}/tx/${input.previous_output.txid.toString()}/hex`,
                { signal: AbortSignal.timeout(15000) }
              )
              if (!response.ok) throw new Error('Could not verify splice input transaction')
              previous.push(hexToBytes((await response.text()).trim()))
            }
          }
          this.assertAlive()
          signed = bytesToHex(signSpliceFunding(this.deps.wallet, event.unsigned, previous, q))
          await this.save({ ...state, status: 'signed', signedTx: signed, unsignedHash: hash })
        }
        this.assertAlive()
        if (this.submittedHash !== hash) {
          const result = this.deps.node.channelManager.funding_transaction_signed(
            ChannelId.constructor_from_bytes(hexToBytes(event.channelId)),
            hexToBytes(q.providerId),
            hexToBytes(signed)
          )
          const alreadyHandled =
            result instanceof Result_NoneAPIErrorZ_Err &&
            result.err instanceof APIError_APIMisuseError &&
            /^Channel(?: with id)? [0-9a-f]+ not expecting funding signatures$/.test(result.err.err)
          // A persisted event may replay after LDK has already accepted this
          // exact, durably stored transaction. It no longer expects signatures.
          if (!result.is_ok() && !alreadyHandled)
            throw new Error('LDK did not accept the splice signatures; inputs remain reserved')
          this.submittedHash = hash
        }
        await this.deps.persistManager()
        await this.trackFundingTransaction()
        this.deps.node.peerManager.process_events()
      } else if (event.kind === 'pending') {
        await this.save({ ...this.state!, status: 'pending', newFundingOutpoint: event.outpoint })
        await this.trackFundingTransaction()
      } else if (event.kind === 'failed') {
        if (!q.inputs.every((c) => event.inputs.includes(c.outpoint)))
          throw new Error('Not all splice inputs have been released')
        await this.save({
          ...this.state!,
          status: 'failed',
          error: 'Adding funds failed. Your on-chain inputs were released.',
        })
      } else await this.reconcileReady()
    })
  private async trackFundingTransaction() {
    const state = this.state
    if (!state?.signedTx || !state.newFundingOutpoint) return
    this.deps.wallet.apply_unconfirmed_txs([
      new UnconfirmedTx(
        Transaction.from_bytes(hexToBytes(state.signedTx)),
        BigInt(Math.floor(Date.now() / 1000))
      ),
    ])
    const staged = this.deps.wallet.take_staged()
    if (staged && !staged.is_empty()) await putChangeset(staged.to_json())
  }
  private async reconcileReady() {
    const state = this.state
    if (!state || !splicePending(state) || !state.newFundingOutpoint) return
    const ch = this.channel(),
      point = ch.get_funding_txo()
    if (
      ch.get_user_channel_id().toString() !== state.quote.userChannelId ||
      !ch.get_is_usable() ||
      `${txidBytesToHex(point.get_txid())}:${point.get_index()}` !== state.newFundingOutpoint
    )
      return
    await this.trackFundingTransaction()
    const newChannelId = bytesToHex(ch.get_channel_id().write())
    const delay = ch.get_force_close_spend_delay()
    await recordFundingTxo(newChannelId, {
      txid: txidBytesToHex(point.get_txid()),
      vout: point.get_index(),
      ...(delay instanceof Option_u16Z_Some ? { timelockBlocks: delay.some } : {}),
    })
    await this.deps.rebind(state.quote.channelId, newChannelId)
    await this.save({ ...state, status: 'complete', newChannelId })
  }
  tick = () =>
    this.serial(async () => {
      await this.reconcileReady()
      if (this.state?.status === 'complete' && this.state.conversion === 'waiting') {
        await this.deps.allocateAll(async () => {
          await this.save({ ...this.state!, conversion: 'attempted' })
        })
        await this.save({ ...this.state, conversion: 'done', error: null })
      }
    })
}
