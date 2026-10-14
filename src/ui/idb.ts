// Minimal promise wrapper around IndexedDB, used for the browser workspace and
// for remembering the folder picked in the browser.
//
// Two object stores: "files" (workspace path → bytes) and "meta" (small values:
// backup times, the folder handle).

const DB_NAME = 'narwal-db';
// Version 2 adds no data: upgrading re-runs the setup below, which creates any missing
// store. (Firefox was seen with a version-1 database that had none.)
const DB_VERSION = 2;
// Earlier name of the database; its contents are moved to DB_NAME once.
const OLD_DB_NAME = 'narwal-score';

export type Store = 'files' | 'meta';

let opening: Promise<IDBDatabase | null> | null = null;

/** The database, or null if IndexedDB is not available (e.g. blocked by the browser). */
export function openDb(): Promise<IDBDatabase | null> {
  opening ??= new Promise<{ db: IDBDatabase; created: boolean } | null>((resolve) => {
    try {
      let created = false;
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        created = e.oldVersion === 0;
        for (const store of ['files', 'meta']) if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store);
      };
      req.onsuccess = () => {
        // Let a newer version of the app (in another tab) upgrade the database.
        req.result.onversionchange = () => req.result.close();
        resolve({ db: req.result, created });
      };
      req.onerror = () => resolve(null);
      // Blocked: another tab still has the older version open. Wait for it to close (the
      // startup reports a database that takes too long, and suggests closing other tabs).
      req.onblocked = () => {};
    } catch {
      resolve(null);
    }
  }).then(async (r) => {
    if (r?.created) await migrateOldDb(r.db).catch(() => {});
    return r?.db ?? null;
  });
  return opening;
}

/** Open an existing database without creating it; null if it does not exist. */
function openExisting(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(name);
      // A version change means the database did not exist: abort so it is not created.
      req.onupgradeneeded = () => req.transaction?.abort();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      // Blocked: another tab still has the older version open. Wait for it to close (the
      // startup reports a database that takes too long, and suggests closing other tabs).
      req.onblocked = () => {};
    } catch {
      resolve(null);
    }
  });
}

/** Copy the files and settings of the database's earlier name, then delete it. */
async function migrateOldDb(db: IDBDatabase) {
  const old = await openExisting(OLD_DB_NAME);
  if (!old) return;
  const stores = (['files', 'meta'] as const).filter((s) => old.objectStoreNames.contains(s));
  for (const s of stores) await idbPutAll(db, s, await idbEntries(old, s));
  old.close();
  indexedDB.deleteDatabase(OLD_DB_NAME);
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
