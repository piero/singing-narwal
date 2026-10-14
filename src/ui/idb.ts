// Minimal promise wrapper around IndexedDB, used for the browser workspace and
// for remembering the folder picked in the browser.
//
// Two object stores: "files" (workspace path → bytes) and "meta" (small values:
// backup times, the folder handle).

const DB_NAME = 'narwal-score';

export type Store = 'files' | 'meta';

let opening: Promise<IDBDatabase | null> | null = null;

/** The database, or null if IndexedDB is not available (e.g. blocked by the browser). */
export function openDb(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('files');
        req.result.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

function request<T>(db: IDBDatabase, store: Store, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    // Resolve when the transaction commits, so that a write is really stored.
    tx.oncomplete = () => resolve(req.result as T);
    tx.onerror = () => reject(tx.error ?? req.error);
    tx.onabort = () => reject(tx.error ?? new Error('Storage transaction aborted'));
  });
}

export const idbGet = <T>(db: IDBDatabase, store: Store, key: string) => request<T | undefined>(db, store, 'readonly', (s) => s.get(key));
export const idbPut = (db: IDBDatabase, store: Store, key: string, value: unknown) => request<void>(db, store, 'readwrite', (s) => s.put(value, key));
export const idbDelete = (db: IDBDatabase, store: Store, key: string) => request<void>(db, store, 'readwrite', (s) => s.delete(key));

/** All entries of a store. */
export function idbEntries<T>(db: IDBDatabase, store: Store): Promise<[string, T][]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const out: [string, T][] = [];
    const req = tx.objectStore(store).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      out.push([String(c.key), c.value as T]);
      c.continue();
    };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
  });
}

/** Write several entries in one transaction (all or nothing). */
export function idbPutAll(db: IDBDatabase, store: Store, entries: [string, unknown][]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const s = tx.objectStore(store);
    for (const [k, v] of entries) s.put(v, k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Storage transaction aborted'));
  });
}
