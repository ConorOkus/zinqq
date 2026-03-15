import { BroadcasterInterface } from 'lightningdevkit'
import { bytesToHex } from '../utils'

const MAX_BROADCAST_RETRIES = 5
const RETRY_DELAY_MS = 1_000

async function broadcastWithRetry(esploraUrl: string, txHex: string): Promise<void> {
  for (let attempt = 1; attempt <= MAX_BROADCAST_RETRIES; attempt++) {
    try {
      const res = await fetch(`${esploraUrl}/tx`, {
        method: 'POST',
        body: txHex,
      })
      if (res.ok) {
        const txid = await res.text()
        console.info(`[LDK Broadcaster] Broadcast tx: ${txid}`)
        return
      }
      const body = await res.text()
      if (
        body.includes('Transaction already in block chain') ||
        body.includes('txn-already-known')
      ) {
        console.info('[LDK Broadcaster] Tx already known, skipping retry')
        return
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
  console.error(`[LDK Broadcaster] CRITICAL: All broadcast attempts failed for tx ${txHex.slice(0, 16)}...`)
}

export function createBroadcaster(esploraUrl: string): BroadcasterInterface {
  return BroadcasterInterface.new_impl({
    broadcast_transactions(txs: Uint8Array[]): void {
      for (const tx of txs) {
        const txHex = bytesToHex(tx)
        void broadcastWithRetry(esploraUrl, txHex)
      }
    },
  })
}
