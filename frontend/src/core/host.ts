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
export async function fetchBytes(url: string): Promise<ArrayBuffer> {
  if (canFetchDirect(url)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
    return res.arrayBuffer();
  }
  const res = await fetch(`${apiUrl("relay")}?${relayParams(url, "bytes")}`);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = (await res.json()).message || msg;
    } catch {
      // keep the status text
    }
    throw new Error(msg);
  }
  return res.arrayBuffer();
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
