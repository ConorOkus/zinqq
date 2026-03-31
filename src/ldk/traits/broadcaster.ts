import { BroadcasterInterface } from 'lightningdevkit'
import { bytesToHex } from '../utils'
import { idbPut, idbDelete, idbGetAll } from '../../storage/idb'

const MAX_BROADCAST_RETRIES = 5
const RETRY_DELAY_MS = 1_000
const PENDING_BROADCAST_TTL_MS = 48 * 60 * 60 * 1_000 // 48 hours

const inflightTxs = new Set<string>()

export async function broadcastWithRetry(esploraUrl: string, txHex: string): Promise<string> {
  if (inflightTxs.has(txHex)) {
    console.info('[LDK Broadcaster] Skipping duplicate in-flight broadcast')
    return 'in-flight'
  }
  inflightTxs.add(txHex)
  try {
    for (let attempt = 1; attempt <= MAX_BROADCAST_RETRIES; attempt++) {
      try {
        const res = await fetch(`${esploraUrl}/tx`, {
          method: 'POST',
          body: txHex,
        })
        if (res.ok) {
          const txid = await res.text()
          console.info(`[LDK Broadcaster] Broadcast tx: ${txid}`)
          return txid
        }
        const body = await res.text()
        const lower = body.toLowerCase()
        if (
          lower.includes('transaction already in block chain') ||
          lower.includes('txn-already-known') ||
          lower.includes('txn-already-confirmed')
        ) {
          console.info('[LDK Broadcaster] Tx already known, skipping retry')
          return 'already-broadcast'
        }
        throw new Error(`HTTP ${res.status.toString()}: ${body}`)
      } catch (err: unknown) {
        console.error(
          `[LDK Broadcaster] Broadcast attempt ${attempt.toString()}/${MAX_BROADCAST_RETRIES.toString()} failed:`,
          err
        )
        if (attempt < MAX_BROADCAST_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * 2 ** (attempt - 1)))
        }
      }
    }
    throw new Error(
      `All ${MAX_BROADCAST_RETRIES.toString()} broadcast attempts failed for tx ${txHex.slice(0, 16)}...`
    )
  } finally {
    inflightTxs.delete(txHex)
  }
}

export function createBroadcaster(esploraUrl: string): BroadcasterInterface {
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
        void broadcastWithRetry(esploraUrl, txHex)
          .then(() => persisted)
          .then(() => idbDelete('ldk_pending_broadcasts', txHex))
          .catch((err: unknown) => {
            console.error('[LDK Broadcaster] CRITICAL: broadcast failed:', err)
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
export async function drainPendingBroadcasts(esploraUrl: string): Promise<void> {
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
    void broadcastWithRetry(esploraUrl, entry.txHex)
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
