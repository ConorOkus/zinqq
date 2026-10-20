import type { LdkNode } from '../ldk/init'
import type { VssClient } from '../ldk/storage/vss-client'
import type { JitQuote } from '../ldk/context'
import type { JitInvoiceResult } from '../ldk/lsps2/types'
import { captureError } from '../storage/error-log'
import { StableClient } from './client'
import { StableStore } from './store'
import { fetchPrice } from './price'
import { SETTLEMENT_TLV, TRADE_TLV } from './protocol'
import {
  hasPendingPayments,
  providerChannel,
  sendStableKeysend,
  signStable,
  verifyStable,
} from './ldk'
import type { StablePaymentEvent, StableProvider, StableSnapshot } from './types'
import type { Wallet } from '@bitcoindevkit/bdk-wallet-web'
import { SpliceController, splicePending, type SpliceEvent } from './splice'
import { getKnownPeers, putKnownPeer } from '../ldk/storage/known-peers'

export const PUBLIC_STABLE_PROVIDER: StableProvider = {
  nodeId: '0388948c5c7775a5eda3ee4a96434a270f20f5beeed7e9c99f242f21b87d658850',
  host: 'stablechannels.com',
  port: 9735,
}
export function configuredStableProvider(): StableProvider {
  const provider = {
    nodeId:
      (import.meta.env.VITE_STABLE_PROVIDER_NODE_ID as string | undefined)?.trim() ||
      PUBLIC_STABLE_PROVIDER.nodeId,
    host:
      (import.meta.env.VITE_STABLE_PROVIDER_HOST as string | undefined)?.trim() ||
      PUBLIC_STABLE_PROVIDER.host,
    port: Number(import.meta.env.VITE_STABLE_PROVIDER_PORT ?? PUBLIC_STABLE_PROVIDER.port),
  }
  if (
    !/^(02|03)[0-9a-f]{64}$/.test(provider.nodeId) ||
    !/^[a-zA-Z0-9._-]+$/.test(provider.host) ||
    !Number.isInteger(provider.port) ||
    provider.port < 1 ||
    provider.port > 65535
  )
    throw new Error('Invalid stability provider configuration')
  return provider
}

async function rememberProvider(provider: StableProvider): Promise<void> {
  const peers = await getKnownPeers()
  if (!peers.has(provider.nodeId)) await putKnownPeer(provider.nodeId, provider.host, provider.port)
}

const INITIAL: StableSnapshot = {
  state: null,
  price: null,
  priceFresh: false,
  channel: null,
  status: 'Loading stable balance',
  error: null,
  busy: false,
}
let snapshot = INITIAL
let runtime: StableRuntime | null = null
const listeners = new Set<() => void>()
function publish(value: StableSnapshot) {
  snapshot = value
  listeners.forEach((listener) => listener())
}
export const subscribeStable = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const getStableSnapshot = () => snapshot
export const getStableRuntime = () => runtime

export function assertNoPendingStableOperation(): void {
  if (runtime?.client.blocksOrdinaryPayments() || splicePending(runtime?.splice?.state ?? null))
    throw new Error(
      'Wait for the stable balance adjustment to finish before sending another payment'
    )
}

export interface StableRuntime {
  client: StableClient
  provider: StableProvider
  splice: SpliceController | null
  enable: () => Promise<void>
  quoteFunding: (amountSats: bigint, signal?: AbortSignal) => Promise<JitQuote>
  confirmFunding: (quote: JitQuote, signal?: AbortSignal) => Promise<JitInvoiceResult>
  stop: () => void
}
interface RuntimeOptions {
  node: LdkNode
  vss: VssClient | null
  alive(): boolean
  healthy(): boolean
  wallet?: Wallet
  persistManager?: () => Promise<void>
  setSpliceCallback?: (cb: ((event: SpliceEvent) => void | Promise<void>) | undefined) => void
  setPaymentCallback(cb: ((event: StablePaymentEvent) => void | Promise<void>) | undefined): void
  quoteFunding(provider: StableProvider, amountSats: bigint, signal: AbortSignal): Promise<JitQuote>
  confirmFunding(quote: JitQuote, signal: AbortSignal): Promise<JitInvoiceResult>
}

export async function startStableRuntime(options: RuntimeOptions): Promise<StableRuntime | null> {
  try {
    const configured = configuredStableProvider()
    const store = new StableStore(configured, options.vss)
    await store.load()
    if (!options.alive()) return null
    runtime?.stop()
    const provider = store.state.enabled ? store.state.provider : configured
    if (store.state.enabled) await rememberProvider(provider)
    if (!options.alive()) return null
    let splice: SpliceController | null = null
    const canSend = () =>
      options.alive() &&
      options.healthy() &&
      document.visibilityState === 'visible' &&
      navigator.onLine &&
      !hasPendingPayments(options.node) &&
      !splicePending(splice?.state ?? null)
    const client = new StableClient({
      store,
      provider,
      channel: () => providerChannel(options.node, provider),
      canSend,
      sign: (bytes) => signStable(options.node, bytes),
      verify: (bytes, signature) => verifyStable(provider, bytes, signature),
      send: (intent) => sendStableKeysend(options.node, provider, intent, canSend),
      price: (previous) => fetchPrice(previous),
    })
    if (options.wallet && options.persistManager && options.setSpliceCallback) {
      splice = new SpliceController({
        node: options.node,
        wallet: options.wallet,
        providerId: provider.nodeId,
        vss: options.vss,
        alive: () => options.alive(),
        canStart: () =>
          canSend() &&
          store.state.enabled &&
          !store.state.paused &&
          !store.state.pending &&
          !store.state.inbox.length &&
          options.node.channelManager
            .list_channels()
            .every((channel) => channel.get_is_channel_ready()) &&
          !client.getSnapshot().busy,
        persistManager: options.persistManager,
        rebind: client.rebindSplicedChannel,
        allocateAll: client.allocateAll,
      })
      await splice.load()
      if (!options.alive()) {
        splice.stop()
        client.stop()
        return null
      }
      options.setSpliceCallback(splice.handle)
    }
    if (store.state.enabled) options.node.trustedLspIds.add(provider.nodeId)
    options.setPaymentCallback((event) => {
      if (!client.handles(event)) return
      const persisted = client.onPayment(event)
      void persisted.then(
        () => {
          void client.processInbox().catch(() => {})
        },
        () => {}
      )
      return persisted
    })
    const unsubscribe = client.subscribe(() => {
      if (runtime?.client === client) publish(client.getSnapshot())
    })
    let updating = false
    let lastTick = 0
    const update = async () => {
      if (
        updating ||
        !options.alive() ||
        !store.state.enabled ||
        document.visibilityState !== 'visible'
      )
        return
      updating = true
      try {
        await client.processInbox().catch(() => {})
        await client.refresh()
        await splice?.tick()
        if (store.state.firstReceive?.received && !store.state.firstReceive.attempted)
          await client.autoConvertFirstReceive()
        if (Date.now() - lastTick >= 60_000) {
          lastTick = Date.now()
          await client.tick()
        }
      } catch {
        return
      } finally {
        updating = false
      }
    }
    const timer = setInterval(() => {
      void update()
    }, 15_000)
    const onVisibility = () => {
      client.refreshStatus()
      if (document.visibilityState === 'visible') void update()
    }
    document.addEventListener('visibilitychange', onVisibility)
    const current: StableRuntime = {
      client,
      provider,
      splice,
      enable: async () => {
        await client.enable()
        if (!options.alive()) throw new Error('Wallet stopped')
        await rememberProvider(provider)
        if (!options.alive()) throw new Error('Wallet stopped')
        options.node.trustedLspIds.add(provider.nodeId)
        void update()
      },
      quoteFunding: (sats, signal) => {
        if (!store.state.enabled || !options.alive() || sats <= 0n)
          return Promise.reject(new Error('Select the provider and enter a funding amount first'))
        return options.quoteFunding(provider, sats, signal ?? AbortSignal.timeout(20_000))
      },
      confirmFunding: (quote, signal) => {
        if (!options.alive() || !store.state.enabled || quote.contact.nodeId !== provider.nodeId)
          return Promise.reject(new Error('Funding quote is for a different provider'))
        return options.confirmFunding(quote, signal ?? new AbortController().signal)
      },
      stop: () => {
        clearInterval(timer)
        unsubscribe()
        client.stop()
        splice?.stop()
        options.setSpliceCallback?.(undefined)
        document.removeEventListener('visibilitychange', onVisibility)
        if (runtime === current) {
          options.setPaymentCallback(undefined)
          runtime = null
          delete (window as unknown as { __stableBalance?: unknown }).__stableBalance
          publish(INITIAL)
        }
      },
    }
    runtime = current
    publish(client.getSnapshot())
    ;(window as unknown as { __stableBalance: unknown }).__stableBalance = {
      getStatus: client.getSnapshot,
      provider,
      enable: current.enable,
      refresh: client.refresh,
      quoteTrade: client.quote,
      quoteMaximumTrade: client.quoteMaximum,
      commitTrade: client.commit,
      pause: client.pause,
      clearClosedPosition: client.clearClosedPosition,
      quoteFunding: current.quoteFunding,
      confirmFunding: current.confirmFunding,
      autoConvertFirstReceive: client.autoConvertFirstReceive,
      getSpliceStatus: () => splice?.state ?? null,
      quoteSplice: splice?.quote,
      quoteMaximumSplice: splice?.quoteMaximum,
      commitSplice: splice?.commit,
      cancelUnsignedSplice: splice?.cancelUnsigned,
    }
    return current
  } catch (error) {
    if (options.alive()) {
      options.setPaymentCallback((event) => {
        if (
          event.kind !== 'received' ||
          event.records.some(
            (record) => record.type === TRADE_TLV || record.type === SETTLEMENT_TLV
          )
        ) {
          return Promise.reject(
            new Error(
              'Stable balance recovery failed; waiting for the backup before acknowledging payment outcomes'
            )
          )
        }
      })
      const message = error instanceof Error ? error.message : 'Stable balance unavailable'
      publish({ ...INITIAL, status: 'Stable balance unavailable', error: message })
      captureError(
        'error',
        'StableBalance',
        'Initialization failed; no stability payments will be sent',
        message
      )
    }
    return null
  }
}
