import { idbGet, idbPut } from '../../storage/idb'

const STORE = 'ldk_bolt12_offer' as const
const KEY = 'default'

export async function getPersistedOffer(): Promise<string | undefined> {
  return idbGet<string>(STORE, KEY)
}

export async function putPersistedOffer(offerStr: string): Promise<void> {
  return idbPut(STORE, KEY, offerStr)
}
