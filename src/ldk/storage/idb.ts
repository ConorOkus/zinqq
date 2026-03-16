const DB_NAME = 'browser-wallet-ldk'
const DB_VERSION = 6

const STORES = [
  'ldk_seed',
  'ldk_channel_monitors',
  'ldk_channel_manager',
  'ldk_network_graph',
  'ldk_scorer',
  'ldk_spendable_outputs',
  'ldk_known_peers',
  'ldk_rgs_last_sync_timestamp',
  'ldk_funding_txs',
  'wallet_mnemonic',
  'bdk_changeset',
] as const

export type StoreName = (typeof STORES)[number]

let dbInstance: IDBDatabase | null = null

export function openDb(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance)

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = (event) => {
      const db = request.result
      const oldVersion = event.oldVersion

      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store)
        }
      }

      // Migration from v2→v3: clear old random seed and LDK state.
      // The app now derives seeds from a BIP39 mnemonic, so old random
      // seeds are incompatible. Acceptable for Signet-only stage.
      if (oldVersion > 0 && oldVersion < 3) {
        const LDK_STORES_TO_CLEAR = [
          'ldk_seed',
          'ldk_channel_monitors',
          'ldk_channel_manager',
          'ldk_network_graph',
          'ldk_scorer',
          'ldk_spendable_outputs',
          'ldk_known_peers',
        ] as const
        for (const storeName of LDK_STORES_TO_CLEAR) {
          if (db.objectStoreNames.contains(storeName)) {
            const tx = request.transaction!
            tx.objectStore(storeName).clear()
          }
        }
        console.warn('[IDB] Migrated from v%d→v3: cleared old LDK state for mnemonic migration', oldVersion)
      }
    }

    request.onsuccess = () => {
      dbInstance = request.result
      dbInstance.onclose = () => {
        dbInstance = null
      }
      resolve(dbInstance)
    }

    request.onerror = () => {
      reject(new Error(`Failed to open IndexedDB: ${request.error?.message ?? 'unknown error'}`))
    }
  })
}

export async function idbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () =>
      reject(new Error(`IndexedDB get failed: ${req.error?.message ?? 'unknown'}`))
  })
}

export async function idbPut(store: StoreName, key: string, value: unknown): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(new Error(`IndexedDB put failed: ${tx.error?.message ?? 'unknown'}`))
  })
}

export async function idbDelete(store: StoreName, key: string): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () =>
      reject(new Error(`IndexedDB delete failed: ${tx.error?.message ?? 'unknown'}`))
  })
}

export async function idbDeleteBatch(store: StoreName, keys: string[]): Promise<void> {
  if (keys.length === 0) return
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    const objectStore = tx.objectStore(store)
    for (const key of keys) {
      objectStore.delete(key)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () =>
      reject(new Error(`IndexedDB batch delete failed: ${tx.error?.message ?? 'unknown'}`))
  })
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close()
    dbInstance = null
  }
}

export async function idbGetAll<T>(store: StoreName): Promise<Map<string, T>> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const objectStore = tx.objectStore(store)
    const req = objectStore.openCursor()
    const results = new Map<string, T>()

    req.onsuccess = () => {
      const cursor = req.result
      if (cursor) {
        results.set(cursor.key as string, cursor.value as T)
        cursor.continue()
      } else {
        resolve(results)
      }
    }

    req.onerror = () =>
      reject(new Error(`IndexedDB getAll failed: ${req.error?.message ?? 'unknown'}`))
  })
}
