/**
 * ScholarPi Web — Qoder Sites Function entry point (`app`).
 *
 * Browser calls are same-origin:  /functions/v1/app/<route>
 *   health            backend availability + demo quota report
 *   llm/<path>        DeepSeek passthrough (streaming), demo key + quota
 *   chat/completions  explicit streaming alias
 *   relay             cross-origin GET/POST fetch (arXiv, search, pages, PDFs)
 *   search/arxiv      named arXiv entry point
 *
 * The built-in demo papers are static files (/papers/…), so this function only
 * handles what a browser cannot do by itself. Locally, backend/app.py serves the
 * same routes under /api and /functions/v1/app.
 */
import { DEFAULT_MODEL, LIMIT_PER_DAY, LIMIT_PER_HOUR, LIMIT_PER_MIN, UPSTREAM, demoKey } from "./config.ts";
import { apiError, json } from "./http.ts";
import { handleLlm } from "./llm.ts";
import { handleArxiv, handleRelay } from "./relay.ts";
import { clientKey, peek } from "./quota.ts";

declare const Deno: { serve: (handler: (req: Request) => Promise<Response> | Response) => unknown };

const KNOWN = new Set(["health", "llm", "chat", "relay", "search"]);

interface Route {
  name: string;
  rest: string[];
}

/**
 * The gateway rewrites the logical `app` segment to its own upstream name, so the
 * received path may carry an unknown prefix. Find the route keyword instead of
 * assuming a fixed depth.
 */
export function routeOf(pathname: string): Route | null {
  const segments = pathname.split("/").filter(Boolean);
  const index = segments.findIndex((s) => KNOWN.has(s));
  if (index < 0) return null;
  const name = segments[index];
  const rest = segments.slice(index + 1);
  if (name === "chat") return { name: "llm", rest: ["chat", ...rest] };
  return { name, rest };
}

function health(req: Request): Response {
  const key = demoKey();
  const { usage } = peek(clientKey(req));
  return json({
    ok: true,
    demoKey: !!key,
    defaultModel: DEFAULT_MODEL,
    upstream: UPSTREAM,
    relay: true,
    runtime: "sites-function",
    usage,
    limitNote: `公共演示额度：每分钟 ${LIMIT_PER_MIN} 次 / 每小时 ${LIMIT_PER_HOUR} 次 / 每天 ${LIMIT_PER_DAY} 次`,
  });
}

export async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method === "GET" && url.pathname === "/") return json({ ok: true, runtime: "scholarpi-app-function" });

  const route = routeOf(url.pathname);
  if (!route) return apiError("not_found", `未知接口：${url.pathname}`, 404);

  try {
    switch (route.name) {
      case "health":
        return health(req);
      case "relay":
        return await handleRelay(req);
      case "search":
        if (route.rest[0] === "arxiv" && req.method === "GET") return await handleArxiv(req);
        return apiError("not_found", "未知检索接口", 404);
      case "llm":
        if (route.rest.length === 0) return apiError("not_found", "缺少 DeepSeek 路径", 404);
        return await handleLlm(req, route.rest);
      default:
        return apiError("not_found", "未知接口", 404);
    }
  } catch (e) {
    const name = e instanceof Error ? e.name : "Error";
    if (name === "AbortError") return apiError("aborted", "请求已取消。", 499);
    return apiError("function_error", `服务处理失败（${name}）。`, 500);
  }
}

Deno.serve(handler);
