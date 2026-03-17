import { BroadcasterInterface } from 'lightningdevkit'
import { bytesToHex } from '../utils'

const MAX_BROADCAST_RETRIES = 5
const RETRY_DELAY_MS = 1_000

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
          err,
        )
        if (attempt < MAX_BROADCAST_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * 2 ** (attempt - 1)))
        }
      }
    }
    throw new Error(`All ${MAX_BROADCAST_RETRIES.toString()} broadcast attempts failed for tx ${txHex.slice(0, 16)}...`)
  } finally {
    inflightTxs.delete(txHex)
  }
}

export function createBroadcaster(esploraUrl: string): BroadcasterInterface {
  return BroadcasterInterface.new_impl({
    broadcast_transactions(txs: Uint8Array[]): void {
      for (const tx of txs) {
        const txHex = bytesToHex(tx)
        void broadcastWithRetry(esploraUrl, txHex).catch((err: unknown) => {
          console.error('[LDK Broadcaster] CRITICAL: broadcast failed:', err)
        })
      }
    },
  })
}
