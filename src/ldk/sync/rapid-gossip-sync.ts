import {
  RapidGossipSync,
  Option_u64Z,
  Result_u32GraphSyncErrorZ_OK,
  type NetworkGraph,
  type Logger,
} from 'lightningdevkit'
import { idbGet, idbPut } from '../storage/idb'

const IDB_KEY = 'ldk_rgs_last_sync_timestamp'

export interface RgsHandle {
  rgs: RapidGossipSync
  lastSyncTimestamp: number
}

/**
 * Initialize RapidGossipSync: fetch a snapshot from the RGS server and apply
 * it to the NetworkGraph. Uses the last sync timestamp from IDB to request
 * only the delta since the previous sync.
 *
 * The RGS server URL format is: `{baseUrl}/{lastSyncTimestamp}`
 * For a fresh sync, use timestamp 0 to get the full snapshot.
 */
export async function initRapidGossipSync(
  networkGraph: NetworkGraph,
  logger: Logger,
  rgsUrl: string,
): Promise<RgsHandle> {
  const rgs = RapidGossipSync.constructor_new(networkGraph, logger)

  // Restore last sync timestamp from IDB (0 = full snapshot)
  const storedTimestamp = await idbGet<number>(IDB_KEY, 'primary')
  const lastSyncTimestamp = await applyRgsUpdate(rgs, rgsUrl, storedTimestamp ?? 0)

  return { rgs, lastSyncTimestamp }
}

/**
 * Fetch a delta snapshot from the RGS server and apply it to the network graph.
 */
export async function syncRapidGossip(
  handle: RgsHandle,
  rgsUrl: string,
): Promise<void> {
  handle.lastSyncTimestamp = await applyRgsUpdate(
    handle.rgs,
    rgsUrl,
    handle.lastSyncTimestamp,
  )
}

/**
 * Fetch and apply an RGS update. Returns the new sync timestamp.
 */
async function applyRgsUpdate(
  rgs: RapidGossipSync,
  rgsUrl: string,
  lastSyncTimestamp: number,
): Promise<number> {
  const url = `${rgsUrl}/${lastSyncTimestamp}`
  console.log(`[RGS] Fetching snapshot from ${url}`)

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`[RGS] HTTP ${response.status}: ${response.statusText}`)
  }

  const buffer = await response.arrayBuffer()
  const updateData = new Uint8Array(buffer)
  console.log(`[RGS] Received ${updateData.byteLength} bytes`)

  const now = BigInt(Math.floor(Date.now() / 1000))
  const result = rgs.update_network_graph_no_std(
    updateData,
    Option_u64Z.constructor_some(now),
  )

  if (!(result instanceof Result_u32GraphSyncErrorZ_OK)) {
    throw new Error('[RGS] Failed to apply gossip sync update')
  }

  const newTimestamp = result.res
  console.log(`[RGS] Applied snapshot, new timestamp: ${newTimestamp}`)

  // Persist the timestamp for next startup
  await idbPut(IDB_KEY, 'primary', newTimestamp)

  return newTimestamp
}
