import { idbGetAll, idbPut, idbDelete } from './idb'

export interface KnownPeer {
  host: string
  port: number
}

export async function getKnownPeers(): Promise<Map<string, KnownPeer>> {
  return idbGetAll<KnownPeer>('ldk_known_peers')
}

export async function putKnownPeer(pubkey: string, host: string, port: number): Promise<void> {
  await idbPut('ldk_known_peers', pubkey, { host, port })
}

export async function deleteKnownPeer(pubkey: string): Promise<void> {
  await idbDelete('ldk_known_peers', pubkey)
}
