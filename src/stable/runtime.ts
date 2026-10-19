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
  if (runtime?.client.blocksOrdinaryPayments())
    throw new Error(
      'Wait for the stable balance adjustment to finish before sending another payment'
    )
}

export interface StableRuntime {
  client: StableClient
  provider: StableProvider
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
    const canSend = () =>
      options.alive() &&
      options.healthy() &&
      document.visibilityState === 'visible' &&
      navigator.onLine &&
      !hasPendingPayments(options.node)
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
      enable: async () => {
        await client.enable()
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
      commitTrade: client.commit,
      pause: client.pause,
      clearClosedPosition: client.clearClosedPosition,
      quoteFunding: current.quoteFunding,
      confirmFunding: current.confirmFunding,
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
              'Stable balance recovery failed; restart the wallet before acknowledging payment outcomes'
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
