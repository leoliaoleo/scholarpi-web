/**
 * Settings, persisted in localStorage (the desktop version used Zotero.Prefs).
 *
 * Two key modes (see llm.ts):
 *   BYOK   - apiKey is filled in by the user and sent as Authorization.
 *   demo   - apiKey is empty; the Sites Function adds its own DEEPSEEK_API_KEY.
 */
import { API_BASE } from "./host";

const PREFIX = "scholarpi.";

export interface QuickAction {
  id: string;
  label: string;
  /** Prompt template; {text} is replaced with the selected text. */
  prompt: string;
  /** "translate" runs a fast tool-less call; "agent" runs in the paper session. */
  mode: "translate" | "agent";
}

export const DEFAULT_QUICK_ACTIONS: QuickAction[] = [
  { id: "explain", label: "解释", mode: "agent", prompt: "请结合论文上下文解释下面这段内容（必要时查阅论文其他部分），说明其含义、作用以及涉及的关键概念：\n\n{text}" },
  { id: "translate", label: "翻译", mode: "translate", prompt: "" },
  { id: "summarize", label: "总结", mode: "agent", prompt: "请用简洁的要点总结下面这段内容的核心意思：\n\n{text}" },
];

export interface Settings {
  apiKey: string;
  baseUrl: string;
  model: string;
  thinkingLevel: string;
  quickModel: string;
  extraModels: string;
  targetLanguage: string;
  replyLanguage: string;
  customSystemPrompt: string;
  maxReadChars: number;
  searchEngine: "deepseek" | "duckduckgo" | "tavily" | "brave" | "searxng";
  fetchEngine: "deepseek" | "local";
  tavilyKey: string;
  braveKey: string;
  searxngUrl: string;
  annotationColor: string;
  annotationTag: string;
  autoConclusion: boolean;
  /** Follow the agent: jump the reader when it calls go_to_page or cites a page. */
  autoFollow: boolean;
  /** 知识库检索是否让模型先扩展查询（中英同义词），提升跨语言召回。 */
  kbSemantic: boolean;
  /** 导入文献后自动写结构化元数据卡片（会发起一次模型调用）。 */
  kbAutoCard: boolean;
  /** 内置学术 MCP 桥接器：arXiv 检索 / Semantic Scholar 引用 / PDF 抓取。 */
  mcpBridge: boolean;
  /** 用户自备 MCP 服务（Streamable HTTP / SSE），JSON 数组字符串，见 mcp.ts。 */
  mcpServers: string;
  quickActions: QuickAction[];
}

const DEFAULTS: Omit<Settings, "quickActions"> = {
  apiKey: "",
  // Same-origin proxy path: /functions/v1/app/llm on Sites, mirrored by backend/app.py locally.
  baseUrl: `${API_BASE}/llm`,
  model: "deepseek-flash",
  thinkingLevel: "high",
  quickModel: "deepseek-flash",
  extraModels: "",
  targetLanguage: "简体中文",
  replyLanguage: "简体中文",
  customSystemPrompt: "",
  maxReadChars: 8000,
  searchEngine: "deepseek",
  fetchEngine: "deepseek",
  tavilyKey: "",
  braveKey: "",
  searxngUrl: "",
  annotationColor: "#a28ae5",
  annotationTag: "AI",
  autoConclusion: true,
  autoFollow: true,
  kbSemantic: true,
  kbAutoCard: true,
  mcpBridge: true,
  mcpServers: "[]",
};

export function getPref<T = any>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  } catch {
    return undefined;
  }
}

export function setPref(key: string, value: any): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch (e) {
    console.error("[ScholarPi] cannot persist setting", key, e);
  }
}

export function getSettings(): Settings {
  const out: any = {};
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = getPref(k);
    out[k] = v === undefined || v === null || v === "" ? def : v;
    if (typeof def === "string" && typeof out[k] !== "string") out[k] = String(out[k]);
  }
  // An empty apiKey is a valid choice: it means "use the shared demo key".
  out.apiKey = String(getPref<string>("apiKey") ?? "").trim();
  out.maxReadChars = Math.max(1000, Math.min(50000, Number(out.maxReadChars) || 8000));
  out.quickActions = parseQuickActions(getPref("quickActions"));
  out.baseUrl = normalizeBaseUrl(String(out.baseUrl || DEFAULTS.baseUrl));
  return out as Settings;
}

/**
 * A relative baseUrl is a path on this origin, so it must be under the function
 * base: builds before the Sites migration stored the obsolete `/api/llm`.
 */
function normalizeBaseUrl(raw: string): string {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value || (/^\//.test(value) && !value.startsWith(API_BASE))) return DEFAULTS.baseUrl;
  return value;
}

/** Absolute URL for the DeepSeek-compatible endpoint the pi SDK will call. */
export function llmEndpoint(): string {
  const base = getSettings().baseUrl || DEFAULTS.baseUrl;
  return /^https?:\/\//i.test(base) ? base : new URL(base, location.href).origin + base;
}

function parseQuickActions(raw: any): QuickAction[] {
  const list = typeof raw === "string" ? safeJson(raw) : raw;
  if (!Array.isArray(list) || !list.length) return DEFAULT_QUICK_ACTIONS;
  return list
    .filter((a) => a && a.label && (a.mode === "translate" || a.prompt))
    .map((a, i) => ({
      id: String(a.id || `custom${i}`),
      label: String(a.label),
      prompt: String(a.prompt || ""),
      mode: a.mode === "translate" ? "translate" : "agent",
    }));
}

function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function saveSettings(patch: Partial<Settings>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (k === "quickActions") setPref(k, JSON.stringify(v));
    else if (k in DEFAULTS) setPref(k, v);
  }
}

/** True when the user has not supplied a key and the demo path is usable. */
export function usingDemoKey(): boolean {
  return !getSettings().apiKey;
}
