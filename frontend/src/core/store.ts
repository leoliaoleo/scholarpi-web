/**
 * Chat history storage in IndexedDB (the desktop version used a SQLite file).
 * Sessions belong to a paper (libraryID + itemKey of the registry entry).
 */
import { boundRange, del, getAll, getAllByIndex, get, openDB, put, transact } from "./db";

export interface SessionMeta {
  id: string;
  libraryID: number;
  itemKey: string;
  paperTitle: string;
  title: string;
  conclusion: string;
  model: string;
  created: number;
  updated: number;
  messageCount: number;
}

interface MessageRow {
  sessionID: string;
  seq: number;
  role: string;
  msg: any;
  text: string;
  created: number;
}

let readyPromise: Promise<void> | null = null;

export function openStore(): Promise<void> {
  if (!readyPromise) readyPromise = openDB().then(() => undefined);
  return readyPromise;
}

export async function closeStore(): Promise<void> {
  try {
    (await openDB()).close();
  } catch (e) {
    console.error(e);
  }
  readyPromise = null;
}

export function newSessionID(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function messageText(m: any): string {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return m.content
    .map((c: any) => (c.type === "text" ? c.text : c.type === "thinking" ? c.thinking ?? "" : ""))
    .filter(Boolean)
    .join("\n");
}

export async function createSession(meta: Omit<SessionMeta, "created" | "updated" | "messageCount">): Promise<SessionMeta> {
  const now = Date.now();
  const full: SessionMeta = { ...meta, created: now, updated: now, messageCount: 0 };
  await put("sessions", full);
  return full;
}

export async function getSession(id: string): Promise<SessionMeta | null> {
  return (await get<SessionMeta>("sessions", id)) || null;
}

export async function listSessionsForPaper(libraryID: number, itemKey: string): Promise<SessionMeta[]> {
  const rows = await getAllByIndex<SessionMeta>("sessions", "byPaper", boundRange([libraryID, itemKey]));
  return rows.sort((a, b) => b.updated - a.updated);
}

export async function searchSessions(opts: { query?: string; excludeItemKey?: string; limit?: number }): Promise<SessionMeta[]> {
  const all = await getAll<SessionMeta>("sessions");
  const q = (opts.query || "").toLowerCase();
  const pool = all.filter(
    (s) => s.messageCount > 0 && (!opts.excludeItemKey || s.itemKey !== opts.excludeItemKey),
  );
  const scored = await Promise.all(pool.map(async (s) => ({ s, hit: await matches(s, q) })));
  return scored
    .filter((x) => x.hit)
    .map((x) => x.s)
    .sort((a, b) => b.updated - a.updated)
    .slice(0, opts.limit || 20);
}

async function matches(s: SessionMeta, q: string): Promise<boolean> {
  if (!q) return true;
  if (`${s.title} ${s.conclusion} ${s.paperTitle}`.toLowerCase().includes(q)) return true;
  const rows = await getAllByIndex<MessageRow>("messages", "bySession", IDBKeyRange.only(s.id));
  return rows.some((r) => String(r.text || "").toLowerCase().includes(q));
}

export async function updateSession(
  id: string,
  patch: Partial<Pick<SessionMeta, "title" | "conclusion" | "model" | "paperTitle">>,
): Promise<void> {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  await transact(["sessions"], (tx) => {
    const os = tx.objectStore("sessions");
    const req = os.get(id);
    req.onsuccess = () => {
      const meta = req.result as SessionMeta | undefined;
      if (!meta) return;
      for (const k of keys) (meta as any)[k] = (patch as any)[k];
      meta.updated = Date.now();
      os.put(meta);
    };
  });
}

export async function deleteSession(id: string): Promise<void> {
  await transact(["sessions", "messages"], (tx) => {
    tx.objectStore("sessions").delete(id);
    tx.objectStore("messages").delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
  });
}

export async function loadMessages(sessionID: string): Promise<any[]> {
  const rows = await getAllByIndex<MessageRow>("messages", "bySession", IDBKeyRange.only(sessionID));
  return rows.sort((a, b) => a.seq - b.seq).map((r) => r.msg);
}

/** Replace messages from index `from` onward with `messages.slice(from)`. */
export async function saveMessages(sessionID: string, messages: any[], from: number): Promise<void> {
  const now = Date.now();
  const rows: MessageRow[] = messages.slice(from).map((m, i) => ({
    sessionID,
    seq: from + i,
    role: String(m.role || "user"),
    msg: m,
    text: messageText(m),
    created: m.timestamp || now,
  }));
  await transact(["messages", "sessions"], (tx) => {
    tx.objectStore("messages").delete(IDBKeyRange.bound([sessionID, from], [sessionID, Number.MAX_SAFE_INTEGER]));
    const os = tx.objectStore("messages");
    for (const r of rows) os.put(r);
    const sReq = tx.objectStore("sessions").get(sessionID);
    sReq.onsuccess = () => {
      const meta = sReq.result as SessionMeta | undefined;
      if (!meta) return;
      meta.messageCount = messages.length;
      meta.updated = Date.now();
      tx.objectStore("sessions").put(meta);
    };
  });
}

export async function kvGet(key: string): Promise<string | null> {
  const row = await get<{ key: string; value: string }>("kv", key);
  return row ? row.value : null;
}

export async function kvSet(key: string, value: string): Promise<void> {
  await put("kv", { key, value });
}

export async function kvDel(key: string): Promise<void> {
  await del("kv", key);
}
