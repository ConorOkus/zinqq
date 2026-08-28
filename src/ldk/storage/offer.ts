import { idbGet, idbPut, idbDelete } from '../../storage/idb'

const STORE = 'ldk_bolt12_offer' as const
const KEY = 'default'
// Second key in the *existing* store rather than a new one: `STORES` in
// src/storage/idb.ts is a closed const and object stores are only created on a
// DB_VERSION bump, so a new store would throw on every already-installed profile.
const ASYNC_KEY = 'async'

export async function getPersistedOffer(): Promise<string | undefined> {
  return idbGet<string>(STORE, KEY)
}

export async function putPersistedOffer(offerStr: string): Promise<void> {
  return idbPut(STORE, KEY, offerStr)
}

/** The async-receive offer served on our behalf by the static invoice server. */
export async function getPersistedAsyncOffer(): Promise<string | undefined> {
  return idbGet<string>(STORE, ASYNC_KEY)
}

export async function putPersistedAsyncOffer(offerStr: string): Promise<void> {
  return idbPut(STORE, ASYNC_KEY, offerStr)
}

/**
 * Drop the async-receive offer.
 *
 * Called when a later session cannot re-resolve it from the manager — the
 * server has stopped serving the static invoice, so continuing to publish the
 * offer would leave an unpayable code on the receive screen.
 */
export async function clearPersistedAsyncOffer(): Promise<void> {
  return idbDelete(STORE, ASYNC_KEY)
}
