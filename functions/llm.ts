/**
 * DeepSeek passthrough for the pi engine.
 *
 * The visitor's own key (BYOK) travels straight upstream. When the browser
 * sends no key — or the `scholarpi-demo` sentinel — the request is paid for by
 * the DEEPSEEK_API_KEY Secret and goes through the demo quota. The Secret value
 * is never echoed back, not even in an error body.
 */
import { DEMO_SENTINELS, MAX_BODY_BYTES, UA, UPSTREAM, demoKey } from "./config.ts";
import { apiError, bearer, json } from "./http.ts";
import { check, clientKey, strike } from "./quota.ts";

const HOP_BY_HOP = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "set-cookie", "date"]);

function usesDemoKey(req: Request): boolean {
  const token = bearer(req);
  return !token || DEMO_SENTINELS.has(token.toLowerCase());
}

function upstreamHeaders(req: Request, token: string): Headers {
  const h = new Headers({ "User-Agent": UA, Accept: req.headers.get("Accept") || "application/json" });
  if (token) h.set("Authorization", `Bearer ${token}`);
  const ctype = req.headers.get("Content-Type");
  if (ctype) h.set("Content-Type", ctype);
  return h;
}

/**
 * `sub` is whatever followed …/llm in the browser URL, e.g. chat/completions or
 * models — the same path shape as api.deepseek.com.
 */
export async function handleLlm(req: Request, sub: string[]): Promise<Response> {
  const path = sub.join("/");
  const demo = usesDemoKey(req);
  const key = demoKey();
  if (demo && !key) {
    return apiError("missing_demo_key", "演示额度未开启：请在设置中填入自己的 DeepSeek API Key。", 401);
  }
  const token = demo ? key : bearer(req);

  let body: ArrayBuffer | null = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await req.arrayBuffer();
    if (demo && path.startsWith("chat/")) {
      if (body.byteLength > MAX_BODY_BYTES) {
        strike(clientKey(req), 600);
        return apiError("payload_too_large", "单次请求内容过长，请缩小阅读范围或新建会话。", 413);
      }
      const verdict = check(clientKey(req));
      if (!verdict.allowed) {
        return json(
          {
            error: "rate_limited",
            message: `公共演示额度已用完（${verdict.note}）。请稍后再试，或在设置中填入自己的 DeepSeek Key 继续不限次使用。`,
            retryAfter: verdict.retryAfter,
            usage: verdict.usage,
          },
          429,
          { "Retry-After": String(verdict.retryAfter) },
        );
      }
    }
  }

  const ctrl = new AbortController();
  req.signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
  const guard = setTimeout(() => ctrl.abort(), 120_000);
  let upstream: Response;
  try {
    upstream = await fetch(`${UPSTREAM}/${path}`, {
      method: req.method,
      headers: upstreamHeaders(req, token),
      body: body && body.byteLength ? body : undefined,
      redirect: "manual",
      signal: ctrl.signal,
    } as RequestInit);
  } catch (e) {
    clearTimeout(guard);
    const name = e instanceof Error ? e.name : "Error";
    if (name === "AbortError") return apiError("upstream_timeout", "DeepSeek 响应超时，请重试或缩小提问范围。", 504);
    return apiError("upstream_unreachable", `无法连接 DeepSeek（${name}）。`, 502);
  }
  clearTimeout(guard);

  if ([301, 302, 303, 307, 308].includes(upstream.status)) {
    return apiError("redirect_unsupported", "上游返回重定向，请在设置中填入自己的 DeepSeek Key 直连。", 502);
  }

  const headers = new Headers();
  for (const [name, value] of upstream.headers.entries()) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) headers.set(name, value);
  }
  const ctype = upstream.headers.get("content-type") || "application/json";
  if (ctype.includes("text/event-stream")) {
    headers.set("cache-control", "no-cache, no-transform");
    headers.set("x-accel-buffering", "no");
  }
  // Hand the upstream stream over untouched: pi-ai parses the SSE deltas itself.
  return new Response(upstream.body, { status: upstream.status, headers });
}
