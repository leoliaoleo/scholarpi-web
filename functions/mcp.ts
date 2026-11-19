/**
 * MCP bridge for servers the visitor configures in 设置 → MCP 服务配置.
 *
 * A browser cannot POST JSON-RPC to an arbitrary host (no CORS), so the frontend sends
 * one framed call here and this function performs it, returning the raw reply. The
 * protocol (initialize / tools/list / tools/call) lives entirely client-side; the server
 * only ever sees the caller's own endpoint and headers.
 *
 * Guards mirror the relay: http(s) only, no credentials in the URL, no loopback or
 * private ranges (revalidated on every redirect hop), header and body size caps, and a
 * hard timeout. The endpoint must therefore be a public MCP server URL.
 */
import { RELAY_MAX_BYTES, RELAY_TIMEOUT_MS, UA } from "./config.ts";
import { apiError, json, readCapped } from "./http.ts";
import { safeTarget } from "./relay.ts";

const MAX_CALL_BYTES = 128 * 1024;
const MAX_HEADERS = 16;
const DENY_HEADERS = new Set([
  "host",
  "content-length",
  "cookie",
  "set-cookie",
  "authorization-proxy",
  "x-forwarded-for",
  "x-real-ip",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "transfer-encoding",
  "proxy-authorization",
  "via",
  "route",
  "loopback",
]);
const ALLOWED_METHODS = new Set(["initialize", "tools/list", "tools/call", "ping", "notifications/initialized"]);

interface FramedCall {
  endpoint: string;
  body: unknown;
  headers: Record<string, string>;
  protocolVersion: string;
}

/** Parses and validates the envelope; returns an error string instead of throwing. */
async function readCall(req: Request): Promise<{ call: FramedCall | null; error: string }> {
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return { call: null, error: "请求体必须是 JSON 信封 {endpoint, body, headers?}" };
  }
  const endpoint = String(payload?.endpoint || "").trim();
  if (!endpoint) return { call: null, error: "缺少 endpoint" };
  const body = payload.body;
  if (!body || typeof body !== "object") return { call: null, error: "缺少 JSON-RPC body" };
  const method = String((body as any).method || "");
  if (!ALLOWED_METHODS.has(method)) return { call: null, error: `不支持的 MCP 方法：${method || "(空)"}` };
  const raw: Record<string, unknown> = {};
  const headers = payload.headers && typeof payload.headers === "object" ? payload.headers : {};
  for (const [name, value] of Object.entries(headers)) {
    if (Object.keys(raw).length >= MAX_HEADERS) break;
    const lower = String(name).toLowerCase();
    if (DENY_HEADERS.has(lower) || !/^[\x21-\x7e]+$/.test(lower)) continue;
    if (typeof value === "string" && value.length <= 1024) raw[name] = value;
  }
  return {
    call: { endpoint, body, headers: raw as Record<string, string>, protocolVersion: String(payload.protocolVersion || "2024-11-05") },
    error: "",
  };
}

export async function handleMcp(req: Request): Promise<Response> {
  if (req.method !== "POST") return apiError("method_not_allowed", "MCP 桥接只接受 POST", 405);
  const parsed = await readCall(req);
  if (!parsed.call) return apiError("bad_request", parsed.error, 400);
  const { endpoint, body, headers, protocolVersion } = parsed.call;

  const target = await safeTarget(endpoint);
  if (!target.url) return apiError("blocked", target.error, 400);

  const ctrl = new AbortController();
  req.signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
  const timer = setTimeout(() => ctrl.abort(), RELAY_TIMEOUT_MS);
  try {
    let url = target.url;
    let res: Response | null = null;
    for (let hop = 0; hop < 3; hop++) {
      res = await fetch(url.toString(), {
        method: "POST",
        headers: new Headers({
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "User-Agent": UA,
          "MCP-Protocol-Version": protocolVersion,
          ...headers,
        }),
        body: JSON.stringify(body),
        redirect: "manual",
        signal: ctrl.signal,
      } as RequestInit);
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get("location");
        if (!location) break;
        const next = await safeTarget(new URL(location, url).toString());
        if (!next.url) return apiError("blocked", `重定向被拒绝：${next.error}`, 400);
        url = next.url;
        continue;
      }
      break;
    }
    if (!res) return apiError("fetch_failed", "MCP 服务无响应", 502);

    const ctype = res.headers.get("content-type") || "";
    const { bytes, overflow } = await readCapped(res, Math.min(MAX_CALL_BYTES, RELAY_MAX_BYTES));
    if (overflow) return apiError("too_large", "MCP 响应超过大小限制", 413);
    const text = bytes ? new TextDecoder("utf-8").decode(bytes) : "";
    const sessionId = res.headers.get("mcp-session-id") || "";
    return json({
      ok: res.ok,
      status: res.status,
      contentType: ctype,
      text,
      sessionId,
      protocolVersion: res.headers.get("mcp-protocol-version") || "",
      endpoint: url.origin + url.pathname,
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "Error";
    if (name === "AbortError") return apiError("timeout", `MCP 服务超时（${Math.round(RELAY_TIMEOUT_MS / 1000)}s）`, 504);
    return apiError("fetch_failed", `MCP 调用失败：${name}`, 502);
  } finally {
    clearTimeout(timer);
  }
}
