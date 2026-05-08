import { idbGetAll, idbPut, idbDelete } from '../../storage/idb'
import { captureError } from '../../storage/error-log'
import { createSerialPersister, type SerialPersister } from './serial-persister'
import { vssWriteWithConflictRetry } from './vss-write'
import type { VssClient } from './vss-client'

export const KNOWN_PEERS_VSS_KEY = '_known_peers'

export interface KnownPeer {
  host: string
  port: number
}

let vssClient: VssClient | null = null
const vssVersionRef = { current: 0 }
let scheduler: SerialPersister | null = null

export function setKnownPeersVssClient(client: VssClient | null, initialVersion = 0): void {
  vssClient = client
  vssVersionRef.current = initialVersion
  scheduler = client ? createSerialPersister(syncPeersToVss) : null
}

export async function getKnownPeers(): Promise<Map<string, KnownPeer>> {
  return idbGetAll<KnownPeer>('ldk_known_peers')
}

export async function putKnownPeer(pubkey: string, host: string, port: number): Promise<void> {
  await idbPut('ldk_known_peers', pubkey, { host, port })
  await schedulePeerSync()
}

export async function deleteKnownPeer(pubkey: string): Promise<void> {
  await idbDelete('ldk_known_peers', pubkey)
  await schedulePeerSync()
}

async function schedulePeerSync(): Promise<void> {
  if (!scheduler) return
  try {
    await scheduler.schedule()
  } catch (err: unknown) {
    captureError('warning', 'known-peers', 'VSS sync failed', String(err))
  }
}

async function syncPeersToVss(): Promise<void> {
  if (!vssClient) return
  const peers = await getKnownPeers()
  const obj: Record<string, KnownPeer> = Object.fromEntries(peers)
  const value = new TextEncoder().encode(JSON.stringify(obj))
  await vssWriteWithConflictRetry(vssClient, KNOWN_PEERS_VSS_KEY, value, vssVersionRef)
}

export function parseKnownPeers(json: string): Map<string, KnownPeer> {
  const parsed: unknown = JSON.parse(json)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('known_peers must be a JSON object')
  }
  const result = new Map<string, KnownPeer>()
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (
      typeof val === 'object' &&
      val !== null &&
      typeof (val as Record<string, unknown>).host === 'string' &&
      typeof (val as Record<string, unknown>).port === 'number'
    ) {
      result.set(key, val as KnownPeer)
    }
  }
  return result
}
