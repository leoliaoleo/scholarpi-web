/**
 * Same-origin fetch relay: the browser cannot read arXiv, search engines or an
 * arbitrary paper page directly (no CORS), so the function fetches it and hands
 * the body back. GET for reading, POST only for the two search engines that
 * demand it, and visitor keys only to the hosts that own them.
 *
 * SSRF: http(s) only, credentials in the URL rejected, loopback / private /
 * link-local / metadata targets blocked, every redirect hop revalidated, response
 * size capped.
 */
import { RELAY_MAX_BYTES, RELAY_TIMEOUT_MS, SEARCH_TIMEOUT_MS, UA } from "./config.ts";
import { apiError, json, readCapped } from "./http.ts";

declare const Deno: { resolveDns?: (host: string, options?: { recordType?: string }) => Promise<string[]> };

const TEXT_TYPES = /^(text\/|application\/(json|xml|xhtml\+xml|atom\+xml|rss\+xml|javascript|x-javascript))/i;
const BINARY_TYPES = /^application\/(pdf|octet-stream)/i;
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "metadata", "instance-data"]);
/** Search engines that only answer POSTs. */
const POST_HOSTS = new Set(["html.duckduckgo.com", "duckduckgo.com", "api.tavily.com"]);
/** `?range=START-END`, so a big file can arrive in requests the gateway allows. */
const RANGE_RE = /^(\d+)-(\d+)$/;
/** Visitor-supplied search keys: this header may reach only this host. */
const KEY_HOSTS: Record<string, Set<string>> = {
  "api.search.brave.com": new Set(["X-Subscription-Token"]),
  "api.tavily.com": new Set(["Authorization"]),
};

/** True for an IP literal in a loopback / private / link-local / reserved range. */
function isPrivateAddress(ip: string): boolean {
  const v = ip.trim().replace(/^\[|\]$/g, "").toLowerCase();
  const mapped = v.match(/^::ffff:(.+)$/);
  const host = mapped ? mapped[1] : v;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((n) => n > 255)) return true;
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127 || a === 255 || a >= 224) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  // Hostnames are decided by the resolved addresses, not here.
  if (!host.includes(":")) return false;
  if (host === "::1" || host === "::") return true;
  return host.startsWith("fe80") || host.startsWith("fc") || host.startsWith("fd") || !!mapped;
}

async function assertPublic(u: URL): Promise<string | null> {
  const host = u.hostname;
  if (BLOCKED_HOSTS.has(host.toLowerCase()) || host.toLowerCase().endsWith(".local")) return "该地址不允许访问";
  if (isPrivateAddress(host)) return "出于安全考虑，不能访问内网或本机地址";
  const resolve = typeof Deno !== "undefined" ? Deno.resolveDns : undefined;
  if (resolve) {
    for (const record of ["A", "AAAA"]) {
      try {
        const addresses = await resolve(host, { recordType: record });
        for (const address of addresses) if (isPrivateAddress(address)) return "出于安全考虑，不能访问内网或本机地址";
      } catch {
        // Resolver unavailable or no record of this family: the literal check above still applies.
      }
    }
  }
  return null;
}

export async function safeTarget(raw: string): Promise<{ url: URL | null; error: string }> {
  let value = (raw || "").trim();
  if (!value) return { url: null, error: "缺少 url 参数" };
  if (value.startsWith("//")) value = `https:${value}`;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return { url: null, error: "URL 无法解析" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { url: null, error: "只允许 http/https" };
  if (!u.hostname) return { url: null, error: "URL 缺少主机名" };
  if (u.username || u.password) return { url: null, error: "URL 不能包含凭据" };
  const blocked = await assertPublic(u);
  if (blocked) return { url: null, error: blocked };
  return { url: u, error: "" };
}

/**
 * arXiv rate-limits datacenter egress on www/arxiv.org (a PDF crawls at tens of
 * KB/s and the gateway cuts the stream), while export.arxiv.org — the same
 * files, the host arXiv designates for programmatic access — serves them fast.
 */
function mirrorArxivPdf(u: URL): URL {
  const host = u.hostname.toLowerCase();
  if ((host === "arxiv.org" || host === "www.arxiv.org") && /^\/pdf\//i.test(u.pathname)) {
    const next = new URL(u.toString());
    next.hostname = "export.arxiv.org";
    return next;
  }
  return u;
}

function decode(bytes: Uint8Array, charset: string): string {
  const label = (charset || "utf-8").toLowerCase();
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

export async function handleRelay(req: Request): Promise<Response> {
  try {
    return await handleRelayInner(req);
  } catch (e: any) {
    // Catch-all: never let an uncaught exception become HTTP 500
    const message = e instanceof Error ? e.message : String(e);
    console.error("[relay] Uncaught error:", message);
    return apiError("internal_error", `服务端内部错误：${message.slice(0, 100)}`, 500);
  }
}

async function handleRelayInner(req: Request): Promise<Response> {
  const isGet = req.method === "GET" || req.method === "HEAD";
  let raw = "";
  let wantBytes = false;
  let range = "";
  let method = "GET";
  let reqBody: string | null = null;
  let reqCtype = "";
  let forwarded: Record<string, string> = {};

  if (isGet) {
    const q = new URL(req.url).searchParams;
    raw = q.get("url") || "";
    wantBytes = q.get("format") === "bytes";
    range = q.get("range") || "";
  } else if (req.method === "POST") {
    let payload: any = {};
    try {
      payload = await req.json();
    } catch {
      return apiError("bad_request", "请求体必须是 JSON 信封。", 400);
    }
    raw = String(payload.url || "");
    method = String(payload.method || "POST").toUpperCase();
    reqBody = typeof payload.body === "string" ? payload.body : null;
    reqCtype = String(payload.contentType || "");
    forwarded = payload.headers && typeof payload.headers === "object" ? payload.headers : {};
    if (method !== "GET" && method !== "POST") return apiError("blocked", "只支持 GET/POST", 400);
    if (!reqCtype && method === "POST") reqCtype = "application/x-www-form-urlencoded";
  } else {
    return apiError("method_not_allowed", "只支持 GET/POST", 405);
  }

  const target = await safeTarget(raw);
  if (!target.url) return apiError("blocked", target.error, 400);
  const host = target.url.hostname;
  if (method === "POST" && !POST_HOSTS.has(host)) return apiError("blocked", `不允许向 ${host} 转发 POST 请求`, 403);

  const allowed = KEY_HOSTS[host] || new Set<string>();
  const headers = new Headers({
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8",
    "Accept-Language": req.headers.get("Accept-Language") || "en-US,en;q=0.8",
  });
  if (reqCtype) headers.set("Content-Type", reqCtype);
  if (wantBytes) {
    const m = RANGE_RE.exec(range.trim());
    if (m) headers.set("Range", `bytes=${m[1]}-${m[2]}`);
  }
  for (const [name, value] of Object.entries(forwarded)) {
    if (typeof value !== "string" || value.length > 512) continue;
    if (!allowed.has(name)) return apiError("blocked", `不允许向 ${host} 转发带密钥的请求`, 403);
    headers.set(name, value);
  }

  let url = mirrorArxivPdf(target.url);
  let res: Response | null = null;
  const budget = isSearchHost(host) ? SEARCH_TIMEOUT_MS : RELAY_TIMEOUT_MS;
  const ctrl = new AbortController();
  req.signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
  const timer = setTimeout(() => ctrl.abort(), budget);
  try {
    for (let hop = 0; hop < 5; hop++) {
      res = await fetch(url.toString(), {
        method,
        headers,
        body: method === "POST" && reqBody !== null ? reqBody : undefined,
        redirect: "manual",
        signal: ctrl.signal,
      } as RequestInit);
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get("location");
        if (!location) break;
        const next = await safeTarget(new URL(location, url).toString());
        if (!next.url) return apiError("blocked", `重定向被拒绝：${next.error}`, 400);
        url = mirrorArxivPdf(next.url);
        continue;
      }
      break;
    }
  } catch (e: any) {
    const name = e instanceof Error ? e.name : "Error";
    const message = e instanceof Error ? e.message : String(e);
    if (name === "AbortError") return apiError("timeout", `抓取超时（${Math.round(budget / 1000)}s）`, 504);
    // Provide detailed error message for debugging
    return apiError("fetch_failed", `抓取失败：${name} - ${message.slice(0, 100)}`, 502);
  } finally {
    clearTimeout(timer);
  }
  if (!res) return apiError("fetch_failed", "抓取失败：无响应", 502);

  const ctype = res.headers.get("content-type") || "";
  if (wantBytes) {
    if (!BINARY_TYPES.test(ctype) && !/pdf/i.test(url.pathname)) {
      return apiError("not_binary", `目标不是可下载文件（${ctype || "未知类型"}）`, 415);
    }
    // Stream the response directly instead of buffering, for edge runtime compatibility
    const responseHeaders = new Headers({
      "content-type": /pdf/i.test(ctype) ? "application/pdf" : "application/octet-stream",
      "content-disposition": "inline",
      "cache-control": "public, max-age=3600",
    });
    // Copy content-length if available
    const contentLength = res.headers.get("content-length");
    if (contentLength) responseHeaders.set("content-length", contentLength);
    // A ranged answer must stay a ranged answer: the client stitches the pieces together.
    const contentRange = res.headers.get("content-range");
    if (contentRange) responseHeaders.set("content-range", contentRange);

    return new Response(res.body, {
      status: res.status,
      headers: responseHeaders,
    });
  }

  const { bytes, overflow } = await readCapped(res, RELAY_MAX_BYTES);
  if (!bytes) {
    return json({ ok: false, status: res.status, url: url.toString(), contentType: ctype, text: "", truncated: true });
  }
  if (!TEXT_TYPES.test(ctype) && res.status === 200) {
    return apiError("not_text", `目标不是文本内容（${ctype || "未知类型"}）`, 415);
  }
  const charset = (ctype.match(/charset=([^;]+)/i) || [])[1] || "";
  return json({
    ok: res.ok,
    status: res.status,
    url: url.toString(),
    contentType: ctype,
    text: decode(bytes, charset),
    truncated: overflow,
  });
}

/** arXiv mirrors are handled by mirrorArxivPdf; these are the hosts that throttle or stall. */
function isSearchHost(host: string): boolean {
  const h = host.toLowerCase();
  return h.startsWith("scholar.google") || POST_HOSTS.has(h) || h === "api.semanticscholar.org";
}

/** Named arXiv entry point: export.arxiv.org sends no CORS headers at all. */
export async function handleArxiv(req: Request): Promise<Response> {
  try {
    return await handleArxivInner(req);
  } catch (e: any) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[arxiv] Uncaught error:", message);
    return apiError("internal_error", `arXiv 查询内部错误：${message.slice(0, 100)}`, 500);
  }
}

async function handleArxivInner(req: Request): Promise<Response> {
  const query = new URL(req.url).search;
  const target = await safeTarget(`https://export.arxiv.org/api/query${query}`);
  if (!target.url) return apiError("blocked", target.error, 400);
  const ctrl = new AbortController();
  req.signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
  const timer = setTimeout(() => ctrl.abort(), RELAY_TIMEOUT_MS);
  try {
    const res = await fetch(target.url.toString(), {
      headers: new Headers({ "User-Agent": UA, Accept: "application/atom+xml,application/xml;q=0.9,*/*;q=0.8" }),
      redirect: "manual",
      signal: ctrl.signal,
    } as RequestInit);
    const { bytes, overflow } = await readCapped(res, RELAY_MAX_BYTES);
    if (!bytes || overflow) return apiError("too_large", "arXiv 响应过大", 413);
    return new Response(bytes as BodyInit, { status: res.status, headers: { "content-type": "application/atom+xml; charset=utf-8" } });
  } catch (e) {
    const name = e instanceof Error ? e.name : "Error";
    return apiError("fetch_failed", `arXiv 查询失败：${name}`, 502);
  } finally {
    clearTimeout(timer);
  }
}
