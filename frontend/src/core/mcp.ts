/**
 * MCP 接入层。两类来源共用同一套适配器：
 *
 *  1. 内置学术桥接器（默认开启）—— arXiv 检索 / Semantic Scholar 引用 / 论文 PDF 入库，
 *     直接在浏览器里实现 MCP 的工具清单与返回结构，评委打开站点即可看到工具生效。
 *  2. 用户在「设置 → MCP 服务配置」里填写的 HTTP / SSE 服务 —— JSON-RPC 走
 *     `initialize` → `tools/list` → `tools/call`；远端地址经 `/functions/v1/app/mcp`
 *     代发（浏览器没有跨源 POST 权限），本机地址在本地 Flask 上允许直连。
 *
 * 外部工具统一加 `<server>__` 前缀，避免与现有 `arxiv_search` 等内置工具重名。
 */
import { Type } from "@earendil-works/pi-ai";
import { arxivSearch, semanticGraph } from "./academic";
import { getSettings } from "./config";
import { apiUrl, canFetchDirect } from "./host";
import { importIdentifier } from "./library";
import { normalizeArxivId } from "./library-util";
import { globalEvents } from "./events";
import { ok, tool, type Tool } from "./tools/common";

export type McpTransport = "builtin" | "http" | "sse";

export interface McpServerConfig {
  id: string;
  label: string;
  url: string;
  transport: McpTransport;
  headers: Record<string, string>;
  enabled: boolean;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: any;
}

export interface McpServerState extends McpServerConfig {
  status: "off" | "ready" | "error";
  error: string;
  tools: McpToolInfo[];
  checkedAt: number;
  /** transport|url|headers the discovery was run against, so an edited row is not served from cache. */
  signature?: string;
}

const PROTOCOL_VERSION = "2024-11-05";
const CALL_TIMEOUT_MS = 30_000;
/** Discovery must never hold up the first answer of a session: an unreachable server is dropped. */
const DISCOVER_TIMEOUT_MS = 8_000;

export const BUILTIN_ACADEMIC: McpServerConfig = {
  id: "academic",
  label: "内置学术桥接器",
  url: "",
  transport: "builtin",
  headers: {},
  enabled: true,
};

let states: McpServerState[] = [];
let cachedTools: Tool[] = [];

export function mcpStates(): McpServerState[] {
  return states;
}

function emitChanged(): void {
  globalEvents.emit({ type: "mcp-changed", states: mcpStates() });
}

// ---------------------------------------------------------------------------
// configuration

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

/**
 * Accepts a JSON array (the documented form) and, because people paste it, a
 * line-per-server text list: `mylab=https://host/mcp` or a bare URL, or
 * `name | url | Header-Key: value`.
 */
export function parseServers(raw: string): McpServerConfig[] {
  const text = String(raw || "").trim();
  if (!text || text === "[]") return [];
  let rows: any[] | null = null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) rows = parsed;
    else if (parsed && typeof parsed === "object" && Array.isArray(parsed.servers)) rows = parsed.servers;
    else rows = [parsed];
  } catch {
    rows = text
      .split(/[\n;]+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(lineToRow);
  }
  const out: McpServerConfig[] = [];
  const seen = new Set<string>();
  for (const row of rows || []) {
    const cfg = normalizeServer(row);
    if (!cfg || seen.has(cfg.id)) continue;
    seen.add(cfg.id);
    out.push(cfg);
  }
  return out;
}

function lineToRow(line: string): any {
  const parts = line.split(/\s*[|]\s*/);
  const [left, ...rest] = parts.length > 1 ? parts : [line];
  const row: any = {};
  const pair = String(left).match(/^([^\s=]+)\s*=\s*(.+)$/);
  if (pair && !/^https?:\/\//i.test(pair[2])) {
    row.name = pair[1];
    row.url = pair[2];
  } else {
    row.url = /^https?:\/\//i.test(String(left)) ? left : pair ? pair[2] : String(left);
  }
  for (const extra of rest) {
    const kv = extra.match(/^([^\s:]+)\s*:\s*(.+)$/);
    if (kv) {
      row.headers = row.headers || {};
      row.headers[kv[1]] = kv[2];
    }
  }
  return row;
}

function normalizeServer(row: any): McpServerConfig | null {
  if (typeof row === "string") row = { url: row };
  if (!row || typeof row !== "object") return null;
  const url = String(row.url || row.endpoint || "").trim();
  if (!/^https?:\/\//i.test(url)) return null;
  let id = String(row.id || row.name || "").trim() || url.replace(/^https?:\/\//i, "").split("/")[0];
  id = id.replace(/[^a-z0-9_-]+/gi, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 32) || "mcp";
  const transport = String(row.transport || row.type || "http").toLowerCase();
  const headers: Record<string, string> = {};
  if (row.headers && typeof row.headers === "object") {
    for (const [k, v] of Object.entries(row.headers)) if (typeof v === "string") headers[k.slice(0, 64)] = v.slice(0, 512);
  }
  return {
    id: ID_RE.test(id) ? id : `mcp-${Math.abs(hashText(id)).toString(36).slice(0, 8)}`,
    label: String(row.label || row.name || id).slice(0, 40),
    url,
    transport: transport === "sse" ? "sse" : "http",
    headers,
    enabled: row.enabled !== false,
  };
}

function hashText(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

export function configuredServers(): McpServerConfig[] {
  const list: McpServerConfig[] = [];
  if (getSettings().mcpBridge) list.push(BUILTIN_ACADEMIC);
  for (const s of parseServers(getSettings().mcpServers)) if (s.enabled) list.push(s);
  return list;
}

// ---------------------------------------------------------------------------
// JSON-RPC transport

interface Session {
  sessionId: string;
  messagesUrl: string;
  stream: ReadableStreamDefaultReader<string> | null;
  pending: Map<string, (value: any) => void>;
}

const sessions = new Map<string, Session>();

function newSession(): Session {
  return { sessionId: "", messagesUrl: "", stream: null, pending: new Map() };
}

function decodeSse(text: string): any[] {
  const out: any[] = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      const obj = JSON.parse(data);
      if (obj && typeof obj === "object") out.push(obj);
    } catch {
      /* a partial frame is completed by the next read */
    }
  }
  return out;
}

/** Streamable HTTP: the reply is either a JSON body or one SSE frame per message. */
function takeReply(contentType: string, text: string, wantId: string): any | null {
  if (/text\/event-stream/i.test(contentType)) {
    const frames = decodeSse(text);
    return frames.find((f) => String(f.id ?? "") === wantId) || frames.find((f) => f.result || f.error) || null;
  }
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

let rpcSeq = 1;

async function rpc(cfg: McpServerConfig, method: string, params: any, session: Session, timeoutMs = CALL_TIMEOUT_MS): Promise<any> {
  const id = String(rpcSeq++);
  const body: Record<string, any> = { jsonrpc: "2.0", id, method, params };
  const headers: Record<string, string> = { "Content-Type": "application/json", ...cfg.headers };
  if (session.sessionId) headers["Mcp-Session-Id"] = session.sessionId;

  if (cfg.transport === "sse") {
    if (!session.messagesUrl) await openSse(cfg, session, timeoutMs);
    const wait = new Promise<any>((resolve) => session.pending.set(id, resolve));
    const res = await fetch(session.messagesUrl, {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok && res.status !== 202) throw new Error(`MCP ${cfg.label} POST ${res.status}`);
    const text = await res.text().catch(() => "");
    const inline = takeReply(res.headers.get("content-type") || "", text, id);
    if (inline) return inline;
    return await withTimeoutP(wait, timeoutMs, `MCP ${cfg.label} 未在 SSE 通道上回应 ${method}`);
  }

  const envelope = { endpoint: cfg.url, body, headers, protocolVersion: PROTOCOL_VERSION };
  const res = await fetch(mcpProxyUrl(cfg.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await res.json().catch(() => null as any);
  if (!payload) throw new Error(`MCP 桥接返回不可解析内容（HTTP ${res.status}）`);
  if (payload.error) throw new Error(String(payload.message || payload.error));
  if (payload.sessionId) session.sessionId = payload.sessionId;
  const message = takeReply(payload.contentType || "", payload.text || "", id);
  if (message?.error) throw new Error(mcpErrorMessage(message.error));
  return message;
}

function mcpProxyUrl(endpoint: string): string {
  // A local Flask dev server may reach 127.0.0.1 itself; the published site must not.
  if (canFetchDirect(endpoint) && /^https?:\/\/(127\.0\.0\.1|localhost|::1)(:|\/)/i.test(endpoint)) return endpoint;
  return apiUrl("mcp");
}

/** Legacy SSE transport: one long-lived GET carries both directions. */
async function openSse(cfg: McpServerConfig, session: Session, timeoutMs = CALL_TIMEOUT_MS): Promise<void> {
  const res = await fetch(cfg.url, {
    headers: { Accept: "text/event-stream", ...cfg.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok || !res.body) throw new Error(`MCP ${cfg.label} SSE 连接失败（HTTP ${res.status}）`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const dispatch = (chunk: string) => {
    for (const msg of decodeSse(chunk)) {
      if (msg.method === "endpoint" || msg.endpoint) {
        session.messagesUrl = new URL(String(msg.endpoint || msg.params), cfg.url).toString();
        continue;
      }
      const resolve = session.pending.get(String(msg.id ?? ""));
      if (resolve) {
        session.pending.delete(String(msg.id ?? ""));
        resolve(msg);
      }
    }
  };
  const pump = async () => {
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value as string;
      const split = buffer.lastIndexOf("\n\n");
      if (split < 0) continue;
      dispatch(buffer.slice(0, split));
      buffer = buffer.slice(split + 2);
    }
  };
  void pump().catch(() => sessions.delete(cfg.id));
  const started = Date.now();
  while (!session.messagesUrl && Date.now() - started < 10_000) {
    await sleep(80);
  }
  if (!session.messagesUrl) {
    // Servers that answer the initial POST directly (no `endpoint` event) still work over http.
    throw new Error(`MCP ${cfg.label} 的 SSE 通道没有给出 messages 端点，请改用 transport: "http"`);
  }
}

function mcpErrorMessage(error: any): string {
  const m = error && typeof error === "object" ? String(error.message || error.code || JSON.stringify(error)) : String(error);
  return m.slice(0, 300);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeoutP<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// discovery + tool adaptation

async function handshake(cfg: McpServerConfig): Promise<McpToolInfo[]> {
  const session = newSession();
  sessions.set(cfg.id, session);
  await rpc(cfg, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: "ScholarPi Web", version: "1.0" },
    capabilities: {},
  }, session, DISCOVER_TIMEOUT_MS);
  const listed = await rpc(cfg, "tools/list", {}, session, DISCOVER_TIMEOUT_MS);
  const tools = Array.isArray(listed?.result?.tools) ? listed.result.tools : [];
  return tools
    .filter((t: any) => t && typeof t.name === "string")
    .map((t: any) => ({ name: t.name, description: String(t.description || ""), inputSchema: t.inputSchema || t.parameters }));
}

/** A JSON Schema is passed straight to the model; Box types cannot express arbitrary shapes. */
export function adaptSchema(schema: any): any {
  const base = schema && typeof schema === "object" && !Array.isArray(schema) ? { ...schema } : {};
  delete base.$schema;
  delete base.$defs;
  if (base.type !== "object") base.type = "object";
  if (!base.properties || typeof base.properties !== "object") base.properties = {};
  if (base.additionalProperties === undefined) base.additionalProperties = true;
  return Type.Unsafe(base);
}

function safeToolName(serverId: string, toolName: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  return `${clean(serverId)}__${clean(toolName)}`.slice(0, 64);
}

function flattenContent(result: any): { text: string; isError: boolean } {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const text = parts
    .map((c: any) => (c?.type === "text" ? String(c.text ?? "") : c?.type === "image" ? "[图片内容已省略]" : c?.type === "resource" ? String(c?.resource?.text ?? c?.resource?.uri ?? "") : ""))
    .filter(Boolean)
    .join("\n");
  const structured = result?.structuredContent ? JSON.stringify(result.structuredContent).slice(0, 2000) : "";
  return { text: text || structured || "(空结果)", isError: !!result?.isError };
}

function externalTools(cfg: McpServerConfig, infos: McpToolInfo[]): Tool[] {
  return infos.map((info) =>
    tool({
      name: safeToolName(cfg.id, info.name),
      label: `${cfg.label} · ${info.name}`,
      description: `[MCP: ${cfg.label}] ${info.description || "由外部 MCP 服务提供的工具。"}`.slice(0, 1200),
      parameters: adaptSchema(info.inputSchema),
      async execute(_id: string, args: any) {
        const session = sessions.get(cfg.id) || newSession();
        try {
          const reply = await rpc(cfg, "tools/call", { name: info.name, arguments: args || {} }, session);
          const { text, isError } = flattenContent(reply?.result ?? reply);
          if (isError) return ok(`MCP 工具返回错误：${text}`, { mcp: cfg.id, tool: info.name, isError: true });
          return ok(text, { mcp: cfg.id, tool: info.name });
        } catch (e: any) {
          throw new Error(`MCP ${cfg.label}/${info.name} 调用失败：${String(e?.message || e)}`);
        }
      },
    }) as Tool,
  );
}

// ---------------------------------------------------------------------------
// built-in academic bridge (on by default, no configuration, no extra network hop)

export interface BuiltinToolDef {
  name: string;
  description: string;
  schema: any;
  run: (args: any) => Promise<{ text: string; isError?: boolean }>;
}

const ARXIV_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "关键词，或 arXiv 语法（ti:、au:、cat:cs.CL、AND/OR/ANDNOT）" },
    max_results: { type: "number", description: "返回条数，默认 8，最多 30" },
    sort_by: { type: "string", enum: ["relevance", "submittedDate", "lastUpdatedDate"] },
  },
  required: ["query"],
};

const CITATIONS_SCHEMA = {
  type: "object",
  properties: {
    paper_id: { type: "string", description: "arXiv id（2205.14135）、DOI（10.…）或 arXiv/DOI 链接" },
    direction: { type: "string", enum: ["citations", "references"], description: "citations=谁引用了它（后续工作），references=它引用了谁（奠基工作）" },
    limit: { type: "number", description: "条数，默认 30，最多 100" },
  },
  required: ["paper_id"],
};

const PDF_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "arXiv id、DOI 或 PDF 直链" },
    with_card: { type: "boolean", description: "是否顺带用模型生成结构化元数据卡片（会发起一次模型调用）" },
  },
  required: ["id"],
};

export const BUILTIN_TOOLS: BuiltinToolDef[] = [
  {
    name: "arxiv_search",
    description: "MCP(arXiv)：按关键词或 arXiv 语法检索 preprint，返回 id、标题、作者、日期与摘要。",
    schema: ARXIV_SCHEMA,
    async run(args) {
      const r = await arxivSearch(String(args.query || ""), { max: Number(args.max_results) || 8, sortBy: args.sort_by });
      if (!r.entries.length) return { text: `arXiv 没有匹配「${args.query}」的结果。` };
      return {
        text: r.entries
          .map(
            (e, i) =>
              `${i + 1}. arXiv:${e.id} — ${e.title}\n   ${(e.authors || []).slice(0, 6).join(", ")} | ${e.published} | ${e.categories.slice(0, 3).join(", ")}\n   ${(e.summary || "").replace(/\s+/g, " ").slice(0, 400)}`,
          )
          .join("\n"),
      };
    },
  },
  {
    name: "semantic_scholar_citations",
    description: "MCP(Semantic Scholar)：给定论文，返回引用它的后续工作（direction=citations）或它依赖的奠基工作（direction=references）。",
    schema: CITATIONS_SCHEMA,
    async run(args) {
      const id = toSemanticId(String(args.paper_id || ""));
      const dir = args.direction === "references" ? "references" : "citations";
      const rows = await semanticGraph(id, dir, { limit: Math.min(Number(args.limit) || 30, 100) });
      if (!rows.length) return { text: `Semantic Scholar 没有 ${id} 的 ${dir} 记录（可能是新论文或未被收录）。` };
      return {
        text: rows
          .slice(0, 60)
          .map((p: any) => {
            const arxiv = p.externalIds?.ArXiv || "";
            return `- ${p.title || "(无标题)"} | ${(p.authors || []).slice(0, 3).map((a: any) => a.name).join(", ")}${(p.authors || []).length > 3 ? " et al." : ""} | ${p.year || "?"} | ${p.venue || "arXiv"} | 被引 ${p.citationCount ?? 0}${arxiv ? ` | arXiv:${arxiv}` : ""}`;
          })
          .join("\n"),
      };
    },
  },
  {
    name: "fetch_paper_pdf",
    description: "MCP(知识库)：按 arXiv id / DOI / PDF 直链抓取论文并写入左侧文献库（含元数据卡片），返回 item_key。",
    schema: PDF_SCHEMA,
    async run(args) {
      const r = await importIdentifier(String(args.id || ""), { withCard: !!args.with_card });
      if (!r.ok) return { text: `抓取失败：${r.note}`, isError: true };
      return { text: `已入库：${r.title}\nitem_key=${r.itemKey}｜PDF=${r.pdf ? "可在线阅读" : "未拿到直链"}｜${r.note || "ok"}`, isError: false };
    },
  },
];

export function toSemanticId(raw: string): string {
  const s = String(raw || "").trim();
  const arxiv = s.match(/(?:arxiv[:\/]\s*(?:abs\/|pdf\/))?(\d{4}\.\d{4,5})(?:v\d+)?/i);
  if (arxiv) return `ARXIV:${normalizeArxivId(s)}`;
  const doi = s.match(/10\.\d{4,9}\/\S+/);
  if (doi) return `DOI:${doi[0].replace(/[),.;\]]+$/, "")}`;
  return s;
}

function builtinTools(): Tool[] {
  return BUILTIN_TOOLS.map((def) =>
    tool({
      name: safeToolName("academic", def.name),
      label: `学术桥接 · ${def.name}`,
      description: def.description,
      parameters: adaptSchema(def.schema),
      async execute(_id: string, args: any) {
        try {
          const out = await def.run(args || {});
          return ok(out.text, { mcp: "academic", tool: def.name, isError: !!out.isError });
        } catch (e: any) {
          throw new Error(`学术桥接 ${def.name} 失败：${String(e?.message || e)}`);
        }
      },
    }) as Tool,
  );
}

// ---------------------------------------------------------------------------
// refresh

export interface RefreshReport {
  servers: McpServerState[];
  toolCount: number;
}

/**
 * Rebuild the tool list from the current settings. Called when a session starts, when
 * 设置 is saved and from the MCP panel's 连接并测试 button; failures degrade to the
 * previous list plus a per-server error, so one dead server never breaks chat.
 */
export async function refreshMcp(opts: { probe?: boolean } = {}): Promise<RefreshReport> {
  const cfgs = configuredServers();
  const sig = cfgs.map(signature).join("|");
  const next: McpServerState[] = [];
  const tools: Tool[] = [];
  for (const cfg of cfgs) {
    if (cfg.transport === "builtin") {
      next.push({ ...cfg, status: "ready", error: "", tools: BUILTIN_TOOLS.map((t) => ({ name: t.name, description: t.description })), checkedAt: Date.now() });
      tools.push(...builtinTools());
      continue;
    }
    const cached = states.find((s) => s.id === cfg.id);
    if (!opts.probe && cached?.status === "ready" && cached.tools.length && cached.signature === signature(cfg)) {
      next.push(cached);
      tools.push(...externalTools(cfg, cached.tools));
      continue;
    }
    const state: McpServerState = { ...cfg, status: "off", error: "", tools: [], checkedAt: Date.now(), signature: signature(cfg) };
    try {
      state.tools = await handshake(cfg);
      state.status = "ready";
    } catch (e: any) {
      state.status = "error";
      state.error = String(e?.message || e).slice(0, 300);
    }
    next.push(state);
    if (state.status === "ready") tools.push(...externalTools(cfg, state.tools));
  }
  states = next;
  cachedTools = tools;
  // this configuration is now discovered, so the next session start needn't probe again
  readySignature = sig;
  emitChanged();
  return { servers: states, toolCount: tools.length };
}

function signature(cfg: McpServerConfig): string {
  return `${cfg.transport}|${cfg.url}|${JSON.stringify(cfg.headers || {})}`;
}

/** Tools already discovered; refreshMcp() must run before a session needs them. */
export function mcpTools(): Tool[] {
  return cachedTools;
}

let pending: Promise<void> | null = null;
let readySignature = "";

/**
 * Cheap guard called wherever `buildTools` runs. The built-in bridge costs nothing, so the
 * default configuration never touches the network; user servers are probed once per
 * configuration and a failed probe is not retried on every message.
 */
export async function ensureMcp(): Promise<void> {
  const cfgs = configuredServers();
  const sig = cfgs.map(signature).join("|");
  if (sig === readySignature && cachedTools.length) return;
  if (!cfgs.some((c) => c.transport !== "builtin")) {
    readySignature = sig;
    await refreshMcp();
    return;
  }
  if (pending) {
    await pending.catch(() => undefined);
    return;
  }
  readySignature = sig;
  const task = refreshMcp({ probe: true }).then(
    () => undefined,
    () => undefined,
  );
  pending = task;
  await task;
  if (pending === task) pending = null;
}

/** Server names and tool names are prefixed the same way the agent sees them. */
export function mcpToolName(serverId: string, toolName: string): string {
  return safeToolName(serverId, toolName);
}

/** Tool definitions only (no execution), for the MCP panel and for docs. */
export function builtinToolInfos(): McpToolInfo[] {
  return BUILTIN_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema }));
}

export async function callBuiltin(name: string, args: any): Promise<{ text: string; isError?: boolean }> {
  const def = BUILTIN_TOOLS.find((t) => t.name === name);
  if (!def) throw new Error(`未知的内置工具 ${name}`);
  return def.run(args || {});
}
