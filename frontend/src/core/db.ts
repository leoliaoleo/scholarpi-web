/**
 * Minimal IndexedDB layer: sessions, messages, key/value, papers, annotations,
 * uploaded PDF bytes, plus the knowledge base (collections + metadata cards).
 * Replaces the desktop version's SQLite file.
 */
const DB_NAME = "scholarpi";
const DB_VERSION = 2;

export const STORES = ["sessions", "messages", "kv", "papers", "annotations", "blobs", "collections", "cards"] as const;
export type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("sessions")) {
        const s = db.createObjectStore("sessions", { keyPath: "id" });
        s.createIndex("byPaper", ["libraryID", "itemKey"], { unique: false });
      }
      if (!db.objectStoreNames.contains("messages")) {
        const m = db.createObjectStore("messages", { keyPath: ["sessionID", "seq"] });
        m.createIndex("bySession", "sessionID", { unique: false });
      }
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv", { keyPath: "key" });
      if (!db.objectStoreNames.contains("papers")) db.createObjectStore("papers", { keyPath: "itemKey" });
      if (!db.objectStoreNames.contains("annotations")) {
        const a = db.createObjectStore("annotations", { keyPath: "key" });
        a.createIndex("byPaper", ["libraryID", "itemKey"], { unique: false });
      }
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs", { keyPath: "id" });
      // v2: the personal knowledge base
      if (!db.objectStoreNames.contains("collections")) db.createObjectStore("collections", { keyPath: "id" });
      if (!db.objectStoreNames.contains("cards")) db.createObjectStore("cards", { keyPath: "itemKey" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB 被其他标签页占用，请关闭后重试"));
  });
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Run `fn` inside one readwrite transaction and resolve when it commits. */
export async function transact(stores: StoreName[], fn: (tx: IDBTransaction) => unknown): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, "readwrite");
    try {
      fn(tx);
    } catch (e) {
      reject(e);
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("事务已中止"));
  });
}

export async function read<R>(stores: StoreName[], fn: (tx: IDBTransaction) => R | Promise<R>): Promise<R> {
  const db = await openDB();
  const tx = db.transaction(stores, "readonly");
  return await fn(tx);
}

export async function put(store: StoreName, value: any): Promise<void> {
  await transact([store], (tx) => tx.objectStore(store).put(value));
}

export async function bulkPut(store: StoreName, values: any[]): Promise<void> {
  if (!values.length) return;
  await transact([store], (tx) => {
    const os = tx.objectStore(store);
    for (const v of values) os.put(v);
  });
}

export function get<T = any>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return read([store], (tx) => wrap(tx.objectStore(store).get(key)));
}

export async function del(store: StoreName, key: IDBValidKey): Promise<void> {
  await transact([store], (tx) => tx.objectStore(store).delete(key));
}

export function getAll<T = any>(store: StoreName, query?: IDBKeyRange | null, count?: number): Promise<T[]> {
  return read([store], (tx) => wrap<T[]>(tx.objectStore(store).getAll(query, count) as unknown as IDBRequest<T[]>));
}

export function getAllByIndex<T = any>(store: StoreName, index: string, query: IDBKeyRange): Promise<T[]> {
  return read([store], (tx) => wrap<T[]>(tx.objectStore(store).index(index).getAll(query) as unknown as IDBRequest<T[]>));
}

export async function clearStore(store: StoreName): Promise<void> {
  await transact([store], (tx) => tx.objectStore(store).clear());
}

export function boundRange(prefix: IDBValidKey[]): IDBKeyRange {
  return IDBKeyRange.bound(prefix, [...prefix, []], false, true);
}
