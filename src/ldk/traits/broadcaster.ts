import { BroadcasterInterface } from 'lightningdevkit'
import { bytesToHex } from '../utils'
import { idbPut, idbDelete, idbGetAll } from '../../storage/idb'
import { captureError } from '../../storage/error-log'

const MAX_BROADCAST_RETRIES = 5
const FALLBACK_RETRIES = 3
const RETRY_DELAY_MS = 1_000
const PENDING_BROADCAST_TTL_MS = 48 * 60 * 60 * 1_000 // 48 hours

const inflightTxs = new Set<string>()

async function postTxToEsplora(
  url: string,
  txHex: string
): Promise<
  { status: 'ok'; txid: string } | { status: 'known' } | { status: 'error'; body: string }
> {
  const res = await fetch(`${url}/tx`, { method: 'POST', body: txHex })
  if (res.ok) {
    return { status: 'ok', txid: await res.text() }
  }
  const body = await res.text()
  const lower = body.toLowerCase()
  if (
    lower.includes('transaction already in block chain') ||
    lower.includes('txn-already-known') ||
    lower.includes('txn-already-confirmed') ||
    lower.includes('insufficient fee, rejecting replacement')
  ) {
    return { status: 'known' }
  }
  return { status: 'error', body: `HTTP ${res.status.toString()}: ${body}` }
}

export async function broadcastWithRetry(
  esploraUrl: string,
  txHex: string,
  fallbackUrl?: string
): Promise<string> {
  if (inflightTxs.has(txHex)) {
    console.info('[LDK Broadcaster] Skipping duplicate in-flight broadcast')
    return 'in-flight'
  }
  inflightTxs.add(txHex)
  try {
    // Try primary esplora with retries
    const primaryResult = await tryBroadcast(esploraUrl, txHex, MAX_BROADCAST_RETRIES, 'primary')
    if (primaryResult) return primaryResult

    // Try fallback esplora with retries
    if (fallbackUrl) {
      console.warn('[LDK Broadcaster] Primary esplora exhausted, trying fallback:', fallbackUrl)
      const fallbackResult = await tryBroadcast(fallbackUrl, txHex, FALLBACK_RETRIES, 'fallback')
      if (fallbackResult) return fallbackResult
    }

    throw new Error(`All broadcast attempts failed for tx ${txHex.slice(0, 16)}...`)
  } finally {
    inflightTxs.delete(txHex)
  }
}

async function tryBroadcast(
  url: string,
  txHex: string,
  maxRetries: number,
  label: string
): Promise<string | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await postTxToEsplora(url, txHex)
      if (result.status === 'ok') {
        console.info(`[LDK Broadcaster] Broadcast tx (${label}): ${result.txid}`)
        return result.txid
      }
      if (result.status === 'known') {
        console.info(`[LDK Broadcaster] Tx already known (${label})`)
        return 'already-broadcast'
      }
      throw new Error(result.body)
    } catch (err: unknown) {
      console.error(
        `[LDK Broadcaster] ${label} attempt ${attempt.toString()}/${maxRetries.toString()} failed:`,
        err
      )
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * 2 ** (attempt - 1)))
      }
    }
  }
  return null
}

export function createBroadcaster(esploraUrl: string, fallbackUrl?: string): BroadcasterInterface {
  return BroadcasterInterface.new_impl({
    broadcast_transactions(txs: Uint8Array[]): void {
      for (const tx of txs) {
        const txHex = bytesToHex(tx)
        // Fire IDB write and broadcast in parallel — broadcast is time-critical
        // (force-close txs), IDB is for crash recovery on restart.
        // Chain the delete after BOTH put and broadcast complete to prevent
        // a race where delete fires before put commits (leaving orphaned entries).
        const persisted = idbPut('ldk_pending_broadcasts', txHex, {
          txHex,
          createdAt: Date.now(),
        }).catch((err: unknown) =>
          console.error('[LDK Broadcaster] Failed to persist pending tx:', err)
        )
        void broadcastWithRetry(esploraUrl, txHex, fallbackUrl)
          .then(() => persisted)
          .then(() => idbDelete('ldk_pending_broadcasts', txHex))
          .catch((err: unknown) => {
            captureError(
              'critical',
              'Broadcaster',
              'Broadcast failed after all retries',
              String(err)
            )
          })
      }
    },
  })
}

/**
 * Initiate re-broadcast of any pending transactions from IDB that were
 * persisted but not successfully broadcast (e.g., browser crashed mid-broadcast).
 * Called once on startup after LDK init.
 *
 * Note: The returned promise resolves after the IDB read completes, not after
 * all broadcasts finish. Broadcasts run in the background via fire-and-forget.
 * Entries older than PENDING_BROADCAST_TTL_MS are discarded (inputs likely spent).
 */
export async function drainPendingBroadcasts(
  esploraUrl: string,
  fallbackUrl?: string
): Promise<void> {
  const pending = await idbGetAll<{ txHex: string; createdAt: number }>('ldk_pending_broadcasts')
  if (pending.size === 0) return

  const now = Date.now()
  let drained = 0
  let expired = 0

  for (const [key, entry] of pending) {
    if (now - entry.createdAt > PENDING_BROADCAST_TTL_MS) {
      expired++
      void idbDelete('ldk_pending_broadcasts', key)
      continue
    }
    drained++
    void broadcastWithRetry(esploraUrl, entry.txHex, fallbackUrl)
      .then(() => idbDelete('ldk_pending_broadcasts', key))
      .catch((err: unknown) =>
        console.error('[LDK Broadcaster] Pending broadcast retry failed:', err)
      )
  }

  if (drained > 0 || expired > 0) {
    console.log(
      `[LDK Broadcaster] Pending broadcasts: ${drained.toString()} retrying, ${expired.toString()} expired (discarded)`
    )
  }
}
