import { idbGetAll, idbPut, idbDelete } from '../../storage/idb'
import { captureError } from '../../storage/error-log'
import { VssError, type VssClient } from './vss-client'
import { ErrorCode } from './proto/vss_pb'

export const KNOWN_PEERS_VSS_KEY = '_known_peers'

export interface KnownPeer {
  host: string
  port: number
}

let vssClient: VssClient | null = null
let vssVersion = 0

export function setKnownPeersVssClient(client: VssClient | null, initialVersion = 0): void {
  vssClient = client
  vssVersion = initialVersion
}

export async function getKnownPeers(): Promise<Map<string, KnownPeer>> {
  return idbGetAll<KnownPeer>('ldk_known_peers')
}

export async function putKnownPeer(pubkey: string, host: string, port: number): Promise<void> {
  await idbPut('ldk_known_peers', pubkey, { host, port })
  await syncPeersToVss()
}

export async function deleteKnownPeer(pubkey: string): Promise<void> {
  await idbDelete('ldk_known_peers', pubkey)
  await syncPeersToVss()
}

async function syncPeersToVss(): Promise<void> {
  if (!vssClient) return
  try {
    const peers = await getKnownPeers()
    const obj: Record<string, KnownPeer> = Object.fromEntries(peers)
    const value = new TextEncoder().encode(JSON.stringify(obj))
    vssVersion = await vssClient.putObject(KNOWN_PEERS_VSS_KEY, value, vssVersion)
  } catch (err: unknown) {
    if (isVssConflict(err)) {
      // Re-fetch server version and retry once
      try {
        const server = await vssClient.getObject(KNOWN_PEERS_VSS_KEY)
        vssVersion = server ? server.version : 0
        const peers = await getKnownPeers()
        const obj: Record<string, KnownPeer> = Object.fromEntries(peers)
        const value = new TextEncoder().encode(JSON.stringify(obj))
        vssVersion = await vssClient.putObject(KNOWN_PEERS_VSS_KEY, value, vssVersion)
      } catch (retryErr: unknown) {
        captureError('warning', 'known-peers', 'VSS conflict retry failed', String(retryErr))
      }
    } else {
      captureError('warning', 'known-peers', 'VSS sync failed', String(err))
    }
  }
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

function isVssConflict(err: unknown): boolean {
  return err instanceof VssError && err.errorCode === ErrorCode.CONFLICT_EXCEPTION
}
