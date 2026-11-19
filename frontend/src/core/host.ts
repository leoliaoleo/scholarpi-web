/**
 * The only place that talks to the server side.
 *
 * Everything is same-origin: the Qoder Sites Function lives under
 * `/functions/v1/app` (backend/app.py mirrors the same routes for local Flask
 * development). The LLM proxy and demo papers are fetched directly; every
 * third-party URL goes through `<base>/relay`, which is what removes the CORS
 * limitation the browser version would otherwise hit (arXiv, search engines,
 * arbitrary pages). The built-in papers themselves are static files.
 */

export const API_BASE = "/functions/v1/app";
/** Static home of the bundled demo papers (manifest, page text, PDFs). */
export const PAPERS_BASE = "/papers";

export function apiUrl(sub: string): string {
  return `${API_BASE}/${sub.replace(/^\/+/, "")}`;
}

export function isSameOrigin(url: string): boolean {
  try {
    const u = new URL(url, location.href);
    return u.origin === location.origin;
  } catch {
    return true;
  }
}

/** True when a request can go straight out of the browser. */
export function canFetchDirect(url: string): boolean {
  return isSameOrigin(url) || url.startsWith(API_BASE);
}

export interface RelayText {
  ok: boolean;
  status: number;
  url: string;
  contentType: string;
  text: string;
  truncated?: boolean;
  error?: string;
  message?: string;
}

function relayParams(url: string, format?: string): string {
  const q = new URLSearchParams({ url });
  if (format) q.set("format", format);
  return q.toString();
}

/**
 * GET/POST any URL, returning a real Response so callers keep using
 * res.text() / res.json() / DOMParser unchanged.
 */
const RELAY_HEADERS = ["Authorization", "X-Subscription-Token", "X-Tavily-API-Key"];

function relayableHeaders(init: RequestInit): Record<string, string> {
  const src = (init.headers || {}) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const name of RELAY_HEADERS) {
    const value = src[name] || src[name.toLowerCase()];
    if (value) out[name] = value;
  }
  return out;
}

export async function smartFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method || "GET").toUpperCase();
  if (canFetchDirect(url)) return fetch(url, init);

  const headers = relayableHeaders(init);
  if (method === "GET" && !Object.keys(headers).length) {
    const res = await fetch(`${apiUrl("relay")}?${relayParams(url)}`);
    return relayToResponse(res, url);
  }
  const body = typeof init.body === "string" ? init.body : "";
  const res = await fetch(apiUrl("relay"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...apiHeaders() },
    body: JSON.stringify({
      url,
      method,
      body,
      contentType: (init.headers as any)?.["Content-Type"] || "",
      headers,
    }),
  });
  return relayToResponse(res, url);
}

async function relayToResponse(res: Response, url: string): Promise<Response> {
  let data: RelayText;
  try {
    data = await res.json();
  } catch {
    return new Response(`relay 解析失败 (${res.status})`, { status: 502 });
  }
  if (data.error) return new Response(data.message || data.error, { status: res.ok ? 502 : res.status });
  const status = data.status || (data.ok ? 200 : 502);
  const out = new Response(data.text ?? "", {
    status,
    headers: { "content-type": data.contentType || "text/plain" },
  });
  // res.url is read-only but callers (DOMParser base, relative links) rely on it.
  Object.defineProperty(out, "url", { value: data.url || url });
  return out;
}

/** Binary download (PDF) through the relay, as an ArrayBuffer. */
export function fetchBytes(url: string, onProgress?: ProgressFn): Promise<ArrayBuffer> {
  const target = canFetchDirect(url) ? url : `${apiUrl("relay")}?${relayParams(url, "bytes")}`;
  return download(target, onProgress);
}

// ---------------------------------------------------------------------------
// progress-carrying download

/** A transfer that stops answering is an error the visitor can retry, never a spinner. */
const STALL_MS = 10_000;
const ATTEMPTS = 3;

export type ProgressFn = (received: number, total: number) => void;

/**
 * Download a buffer with byte progress, a stall guard and bounded retries.
 *
 * `STALL_MS` arms before the request and re-arms on every chunk, so a slow link that is
 * still delivering keeps going while a dead one fails in ~10s. 4xx is a real answer
 * (missing file, blocked host) and is reported at once instead of retried.
 */
export async function download(url: string, onProgress?: ProgressFn, init: RequestInit = {}): Promise<ArrayBuffer> {
  let failure = new Error("下载失败");
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt) await sleep(400 * attempt);
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => ctrl.abort(), STALL_MS);
    };
    try {
      arm();
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      if (!res.ok) {
        failure = new Error(await failureMessage(res));
        if (res.status >= 400 && res.status < 500) break;
        continue;
      }
      arm();
      return await readWithProgress(res, onProgress, arm);
    } catch (e: any) {
      failure = e?.name === "AbortError" ? new Error(`下载超时：${STALL_MS / 1000} 秒内没有响应`) : new Error(String(e?.message || e));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  throw failure;
}

async function readWithProgress(res: Response, onProgress: ProgressFn | undefined, arm: () => void): Promise<ArrayBuffer> {
  const total = Number(res.headers.get("content-length") || 0);
  if (!res.body) {
    const buf = await res.arrayBuffer();
    onProgress?.(buf.byteLength, buf.byteLength);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    arm();
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    received += value.byteLength;
    onProgress?.(received, total);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer as ArrayBuffer;
}

async function failureMessage(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (data?.message) return String(data.message);
    if (data?.error) return String(data.error);
  } catch {
    // no JSON body: the status is the message
  }
  return `HTTP ${res.status}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function apiJson<T = any>(sub: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(sub), init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
  return data as T;
}

/** JSON from a file shipped in the static bundle (no function round-trip). */
export async function staticJson<T = any>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// backend status (demo key availability, quota)

export interface Health {
  ok: boolean;
  demoKey: boolean;
  defaultModel: string;
  upstream: string;
  relay: boolean;
  usage?: Record<string, number>;
  limitNote?: string;
}

let healthCache: Health | null = null;

export async function getHealth(force = false): Promise<Health | null> {
  if (healthCache && !force) return healthCache;
  try {
    healthCache = await apiJson<Health>("health");
  } catch {
    healthCache = null;
  }
  return healthCache;
}

export function cachedHealth(): Health | null {
  return healthCache;
}

/** A short id shared by all tabs of this browser, so quota follows the person. */
export function clientId(): string {
  const KEY = "scholarpi.client";
  let id = "";
  try {
    id = localStorage.getItem(KEY) || "";
    if (!id) {
      id = Math.random().toString(36).slice(2, 12);
      localStorage.setItem(KEY, id);
    }
  } catch {
    id = "private";
  }
  return id;
}

export function apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "X-Pi-Client": clientId(), ...extra };
}
