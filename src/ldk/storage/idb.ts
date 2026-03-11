const DB_NAME = 'browser-wallet-ldk'
const DB_VERSION = 1

const STORES = [
  'ldk_seed',
  'ldk_channel_monitors',
  'ldk_channel_manager',
  'ldk_network_graph',
  'ldk_scorer',
] as const

export type StoreName = (typeof STORES)[number]

let dbInstance: IDBDatabase | null = null

export function openDb(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance)

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store)
        }
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
