import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { Markdown } from "./markdown";
import { splitBullets } from "../shared/markdown";
import { COPY_FLASH_MS, EMPTY_NOTE_HINT, copyButtonLabel, copyHint } from "../shared/clipboard";
import { classifyError, retryLabel, type ErrorAction } from "../shared/errors";
import { skillDigest } from "../shared/skillprompt";
import { getApi } from "./api";
import { EXAMPLE_ITEM_KEY } from "../core/presets";

export const TOOL_LABELS: Record<string, string> = {
  paper_overview: "论文概览",
  paper_search: "论文内搜索",
  paper_read: "阅读论文",
  view_page_image: "查看页面图像",
  get_annotations: "查看批注",
  create_highlight: "创建高亮",
  create_note_annotation: "创建便签",
  update_annotation_comment: "修改批注",
  go_to_page: "跳转页面",
  library_search: "检索文献库",
  list_sessions: "历史会话",
  read_session: "阅读会话",
  search_annotations: "搜索批注",
  save_conclusion: "记录结论",
  create_zotero_note: "创建笔记",
  web_search: "网络搜索",
  web_fetch: "读取网页",
  arxiv_search: "arXiv 检索",
  arxiv_read: "阅读 arXiv",
  scholar_search: "Google Scholar",
  kb_overview: "知识库概览",
  kb_list: "列出知识库",
  kb_create_collection: "新建研究专题",
  kb_add_to_collection: "归入专题",
  kb_set_tags: "设置标签",
  kb_card: "读取元数据卡片",
  kb_update_card: "更新元数据卡片",
  kb_generate_card: "生成元数据卡片",
  kb_search: "知识库检索",
  kb_import: "导入文献",
  kb_export: "导出知识库",
  academic__arxiv_search: "学术桥接 · arXiv 检索",
  academic__semantic_scholar_citations: "学术桥接 · 引用关系",
  academic__fetch_paper_pdf: "学术桥接 · 抓取 PDF",
};

const TOOL_ICONS: Record<string, string> = {
  paper_overview: "📄",
  paper_search: "🔎",
  paper_read: "📖",
  view_page_image: "🖼",
  get_annotations: "🖍",
  create_highlight: "🖍",
  create_note_annotation: "🗒",
  update_annotation_comment: "✏️",
  go_to_page: "↪",
  library_search: "📚",
  list_sessions: "💬",
  read_session: "💬",
  search_annotations: "🖍",
  save_conclusion: "📌",
  create_zotero_note: "📝",
  web_search: "🌐",
  web_fetch: "🌐",
  arxiv_search: "🧪",
  arxiv_read: "🧪",
  scholar_search: "🎓",
  kb_overview: "📚",
  kb_list: "📚",
  kb_create_collection: "🗂",
  kb_add_to_collection: "🗂",
  kb_set_tags: "🏷",
  kb_card: "📋",
  kb_update_card: "📋",
  kb_generate_card: "📋",
  kb_search: "🔭",
  kb_import: "⇪",
  kb_export: "⇩",
  "academic__arxiv_search": "🧪",
  "academic__semantic_scholar_citations": "🎓",
  "academic__fetch_paper_pdf": "⇪",
};

/** MCP servers the user adds are named `server__tool`, so fall back to a readable form. */
export function toolLabel(name: string): string {
  return TOOL_LABELS[name] || (name.includes("__") ? `MCP · ${name.split("__").slice(1).join("__")}` : name);
}

export function toolIcon(name: string): string {
  return TOOL_ICONS[name] || (name.startsWith("kb_") ? "📚" : name.includes("__") ? "🔌" : "🔧");
}

function argSummary(name: string, args: any): string {
  if (!args) return "";
  const v =
    args.query ??
    args.quote ??
    args.section ??
    (args.pages ? `p.${args.pages}` : undefined) ??
    args.url ??
    args.id ??
    args.comment ??
    args.session_id ??
    args.item_key ??
    (args.ids ? (Array.isArray(args.ids) ? args.ids.join(", ") : args.ids) : undefined) ??
    args.collection ??
    args.name ??
    (args.page ? `p.${args.page}` : "");
  const s = String(v ?? "");
  const extra = args.item_key && (name.startsWith("paper_") || name.startsWith("kb_")) ? ` [${args.item_key}]` : "";
  return (s.length > 60 ? s.slice(0, 60) + "…" : s) + extra;
}

export function imagesOf(m: any): any[] {
  return Array.isArray(m?.content) ? m.content.filter((c: any) => c.type === "image") : [];
}

export function Thumb({ img, title }: { img: { data?: string; mimeType?: string; dataUrl?: string }; title?: string }) {
  const [big, setBig] = useState(false);
  const src = img.dataUrl || `data:${img.mimeType};base64,${img.data}`;
  return <img class={big ? "thumb big" : "thumb"} src={src} title={title || "点击放大 / 缩小"} onClick={() => setBig(!big)} />;
}

export function textOf(m: any): string {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return (m.content || [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("");
}

function fmtSecs(ms: number): string {
  ms = Math.max(0, ms);
  return ms < 10000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

/** Re-render periodically while `active`; returns the current time (read at render). */
export function useTicker(active: boolean, ms = 200): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return Date.now();
}

function ToolCallView({ call, result, pending, active, preparing }: { call: any; result?: any; pending: boolean; active?: any; preparing?: boolean }) {
  const [open, setOpen] = useState(false);
  const status = preparing ? "preparing" : pending || !result ? "running" : result.isError ? "error" : "done";
  const resultText = result ? textOf(result) : "";
  const now = useTicker(!!active);
  const timeLabel = active ? fmtSecs(now - active.startedAt) : result?.durationMs != null ? fmtSecs(result.durationMs) : "";
  return (
    <div class={`tool tool-${status}`}>
      <button class="tool-head" onClick={() => setOpen(!open)} title="展开 / 收起详情">
        <span class="tool-icon">{toolIcon(call.name)}</span>
        <span class="tool-name">{toolLabel(call.name)}</span>
        <span class="tool-arg">{argSummary(call.name, call.arguments)}</span>
        {timeLabel && <span class="tool-time">{timeLabel}</span>}
        <span class="tool-status">
          {status === "preparing" ? <span class="tool-state">准备参数…</span> : status === "running" ? <span class="spinner" /> : status === "error" ? "✗" : "✓"}
        </span>
      </button>
      {open && (
        <div class="tool-body">
          <div class="tool-label">参数</div>
          <pre>{JSON.stringify(call.arguments, null, 2)}</pre>
          {result && imagesOf(result).length > 0 && (
            <div class="thumbs">
              {imagesOf(result).map((im: any, i: number) => (
                <Thumb key={i} img={im} />
              ))}
            </div>
          )}
          {result && (
            <>
              <div class="tool-label">{result.isError ? "错误" : "结果"}</div>
              <pre>{resultText.length > 6000 ? resultText.slice(0, 6000) + "\n…" : resultText}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return live ? <div class="thinking-live"><span class="spinner" /> 思考中…</div> : null;
  return (
    <div class="thinking">
      <button class="thinking-head" onClick={() => setOpen(!open)}>
        {live ? <span class="spinner" /> : "💭"} {live ? "思考中…" : "思考过程"} <span class="chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && <div class="thinking-body">{text}</div>}
    </div>
  );
}

export function UserMessage({ message }: { message: any }) {
  const text = textOf(message);
  // 技能按钮发出去的是写给模型的工单，不是人话：默认只说一句「对比这 N 篇论文」，工单收进展开层。
  const digest = useMemo(() => skillDigest(text), [text]);
  const [open, setOpen] = useState(false);
  return (
    <div class="msg user">
      <div class="bubble">
        {imagesOf(message).length > 0 && (
          <div class="thumbs">
            {imagesOf(message).map((im: any, i: number) => (
              <Thumb key={i} img={im} />
            ))}
          </div>
        )}
        {digest ? (
          <div class="thinking skill-digest">
            <div>{digest.label}</div>
            <button class="thinking-head" onClick={() => setOpen(!open)}>
              {open ? "收起指令原文" : "查看发给模型的完整指令"} <span class="chev">{open ? "▾" : "▸"}</span>
            </button>
            {open && <div class="thinking-body">{digest.detail}</div>}
          </div>
        ) : (
          <Markdown text={text} />
        )}
      </div>
    </div>
  );
}

export function AssistantMessage({
  message,
  results,
  pending,
  live,
  onRetry,
  active,
}: {
  message: any;
  results: Map<string, any>;
  pending: Set<string>;
  live: boolean;
  onRetry?: () => void;
  active?: Map<string, any>;
}) {
  const parts = message.content || [];
  const hasText = parts.some((c: any) => c.type === "text" && c.text.trim());
  return (
    <div class="amsg">
      {parts.map((c: any, i: number) => {
        if (c.type === "thinking") return <Thinking key={i} text={c.thinking || ""} live={live && !hasText && i === parts.length - 1} />;
        if (c.type === "text") return c.text ? <Markdown key={i} text={c.text} live={live} /> : null;
        if (c.type === "toolCall")
          return (
            <ToolCallView
              key={c.id}
              call={c}
              result={results.get(c.id)}
              pending={pending.has(c.id) || (live && !results.has(c.id))}
              active={active?.get(c.id)}
              preparing={live && !active?.has(c.id) && !results.has(c.id)}
            />
          );
        return null;
      })}
      {live && !parts.length && (
        <div class="thinking-live">
          <span class="spinner" /> 正在思考…
        </div>
      )}
      <ErrorBox message={message} onRetry={onRetry} />
    </div>
  );
}

interface ProcItem {
  kind: "thinking" | "text" | "tool";
  part: any;
  key: string;
  live: boolean; // belongs to the streaming message
  lastPart: boolean; // last part of its message
}

function hasNonEmptyText(m: any): boolean {
  return (m?.content || []).some((c: any) => c.type === "text" && c.text?.trim());
}

function hasToolCall(m: any): boolean {
  return (m?.content || []).some((c: any) => c.type === "toolCall");
}

/** Ticks down a server-given wait; never started without trustworthy seconds. */
function useCountdown(seconds?: number): number | undefined {
  const [left, setLeft] = useState<number | undefined>(seconds);
  useEffect(() => {
    if (!seconds) {
      setLeft(undefined);
      return;
    }
    setLeft(seconds);
    const t0 = Date.now();
    const iv = window.setInterval(() => {
      const rest = seconds - Math.floor((Date.now() - t0) / 1000);
      if (rest <= 0) {
        window.clearInterval(iv);
        setLeft(undefined);
      } else setLeft(rest);
    }, 1000);
    return () => window.clearInterval(iv);
  }, [seconds]);
  return seconds ? left : undefined;
}

const ERROR_ACTIONS: Record<ErrorAction, string> = { retry: "重试", example: "查看示例", key: "配置个人 Key" };

function runErrorAction(kind: ErrorAction, retry?: () => void): void {
  if (kind === "retry") retry?.();
  else if (kind === "key") getApi().openSettings();
  else void getApi().openPaper(EXAMPLE_ITEM_KEY);
}

/**
 * A failed reply, said plainly: what happened, what is still safe, and what to do
 * next. Nothing here invents a queue position or a countdown we were not given.
 */
function ErrorBox({ message, onRetry }: { message: any; onRetry?: () => void }) {
  const [open, setOpen] = useState(false);
  const isError = message?.stopReason === "error";
  const isAborted = message?.stopReason === "aborted";
  const err = classifyError(isError ? message?.errorMessage || message?.error || message : "");
  const left = useCountdown(err.retryAfter);
  const wait = left == null || left >= 600 ? "" : `（还剩 ${left < 60 ? `${left} 秒` : `${Math.ceil(left / 60)} 分钟`}）`;
  if (!isError && !isAborted) return null;
  if (isAborted) return <div class="aborted-box">已停止 · 你的问题与草稿都还在。</div>;
  return (
    <div class="error-box">
      <div>{err.message}</div>
      {!!err.retryAfter && (
        <div class="muted small">
          {retryLabel(err.retryAfter)}
          {wait}
        </div>
      )}
      <div class="err-actions">
        {err.actions
          .filter((a) => a !== "retry" || !!onRetry)
          .map((a) => (
            <button class="link-btn" key={a} onClick={() => runErrorAction(a, onRetry)}>
              {ERROR_ACTIONS[a]}
            </button>
          ))}
        {!!err.detail && (
          <button class="link-btn" onClick={() => setOpen(!open)}>
            {open ? "收起详情" : "查看原始信息"}
          </button>
        )}
      </div>
      {open && !!err.detail && <div class="err-detail muted small">{err.detail}</div>}
    </div>
  );
}

/** 划词 / 框图小卡的失败：同一套分类文案，同一条出路。 */
export function QuickError({ error }: { error: string }) {
  return <ErrorBox message={{ stopReason: "error", errorMessage: error }} />;
}

/** 剪贴板 API 在非安全上下文或被站点权限拦掉时会 reject，这里退回到选中文本复制。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续试 execCommand
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * 「复制 Markdown」+「下载笔记 .md」。
 *
 * 内容永远由 `build()` 现场生成，所以只会包含调用点所在的那份报告；复制成功让按钮自己亮
 * 2 秒「已复制 ✓」，被浏览器拒绝时把兜底的下载按钮点亮，不静默吞掉失败。
 */
export function NoteActions({ build, file, label = "笔记", copyLabel = "复制 Markdown", group = "" }: { build: () => string; file: () => string; label?: string; copyLabel?: string; group?: string }) {
  const [status, setStatus] = useState<{ msg: string; text?: string; blocked?: boolean } | null>(null);
  const [flash, setFlash] = useState(false);
  const done = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(null), 9000);
    return () => clearTimeout(t);
  }, [status]);
  useEffect(() => () => clearTimeout(done.current), []);
  const api = getApi();

  const copy = async () => {
    const text = build();
    if (!text.trim()) return setStatus({ msg: EMPTY_NOTE_HINT });
    if (await copyText(text)) {
      setFlash(true);
      clearTimeout(done.current);
      done.current = setTimeout(() => setFlash(false), COPY_FLASH_MS);
      return setStatus({ msg: copyHint(label, true) });
    }
    api.kb.download(file(), text, "text/markdown");
    setStatus({ msg: copyHint(label, false), text, blocked: true });
  };
  const save = () => {
    const text = build();
    if (!text.trim()) return setStatus({ msg: EMPTY_NOTE_HINT });
    api.kb.download(file(), text, "text/markdown");
    setStatus({ msg: `已下载 ${label}笔记（Markdown，含页码引用）。` });
  };

  return (
    <div class="note-actions">
      {group && <span class="note-group muted small">{group}</span>}
      <button class={flash ? "chip note-copied" : "chip"} data-state={flash ? "copied" : "idle"} onClick={() => void copy()} title={`把${label}正文连同标题、来源与页码引用复制成 Markdown`}>
        {copyButtonLabel(flash, copyLabel)}
      </button>
      <button class={status?.blocked ? "chip note-dl-alert" : "chip"} onClick={save} title={`下载 ${label} .md，可导入 Obsidian / Notion / Typora`}>
        下载笔记 .md
      </button>
      {status && (
        <div class="note-status muted small" role="status">
          {status.msg}
          {status.text != null && (
            <textarea
              class="note-fallback"
              readOnly
              value={status.text}
              onFocus={(e) => (e.target as HTMLTextAreaElement).select()}
              aria-label="可复制的笔记文本"
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The thinking / tool-call / narration steps of one reply, folded into a single
 * block. Collapsed by default, showing only the latest step; click to expand.
 */
function ProcessGroup({
  msgs,
  liveMsg,
  live,
  results,
  pending,
  active,
  tailError,
  onRetry,
}: {
  msgs: any[];
  liveMsg: any | null;
  live: boolean;
  results: Map<string, any>;
  pending: Set<string>;
  active: Map<string, any>;
  tailError?: any;
  onRetry?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const items: ProcItem[] = [];
  msgs.forEach((m, mi) => {
    const isLive = m === liveMsg;
    const parts: any[] = m.content || [];
    parts.forEach((c, i) => {
      const lastPart = i === parts.length - 1;
      const base = { part: c, key: `${mi}-${c.id || i}`, live: isLive, lastPart };
      if (c.type === "toolCall") items.push({ kind: "tool", ...base });
      else if (c.type === "text" && c.text?.trim()) items.push({ kind: "text", ...base });
      else if (c.type === "thinking" && ((c.thinking || "").trim() || (isLive && lastPart))) items.push({ kind: "thinking", ...base });
    });
  });
  const tools = items.filter((it) => it.kind === "tool");
  const errors = tools.filter((t) => results.get(t.part.id)?.isError).length;
  const thinkingCount = items.filter((it) => it.kind === "thinking").length;
  const latest = items[items.length - 1];
  const now = useTicker(live, 1000);
  const firstTs = msgs[0]?.timestamp;
  const lastResult = [...tools].reverse().map((t) => results.get(t.part.id)).find(Boolean);
  const endTs = live ? now : lastResult ? lastResult.timestamp : msgs[msgs.length - 1]?.timestamp;
  const elapsed = firstTs && endTs ? fmtSecs(endTs - firstTs) : "";

  const renderItem = (it: ProcItem) => {
    if (it.kind === "thinking") return <Thinking key={it.key} text={it.part.thinking || ""} live={it.live && it.lastPart} />;
    if (it.kind === "text")
      return (
        <div class="proc-text" key={it.key}>
          <Markdown text={it.part.text} live={it.live} />
        </div>
      );
    const c = it.part;
    return (
      <ToolCallView
        key={it.key}
        call={c}
        result={results.get(c.id)}
        pending={pending.has(c.id) || (it.live && !results.has(c.id))}
        active={active.get(c.id)}
        preparing={it.live && !active.has(c.id) && !results.has(c.id)}
      />
    );
  };

  return (
    <div class={`proc ${open ? "open" : ""}`}>
      <button class="proc-head" onClick={() => setOpen(!open)} title={open ? "收起过程" : "展开全部过程"}>
        <span class="chev">{open ? "▾" : "▸"}</span>
        {live ? <span class="spinner" /> : <span class="proc-icon">⚙</span>}
        <span class="proc-title">
          {live ? "处理中" : "处理过程"} · {tools.length} 次工具调用
          {errors ? <span class="proc-err"> · {errors} 次失败</span> : null}
          {thinkingCount ? ` · 思考 ${thinkingCount} 次` : ""}
          {elapsed ? ` · ${elapsed}` : ""}
        </span>
        <span class="proc-toggle">{open ? "收起" : items.length > 1 ? `展开全部 ${items.length} 步` : ""}</span>
      </button>
      <div class="proc-body">
        {open ? items.map(renderItem) : latest ? <div class="proc-latest">{renderItem(latest)}</div> : null}
      </div>
      {tailError && <ErrorBox message={tailError} onRetry={onRetry} />}
    </div>
  );
}

/** One assistant reply (possibly many messages): folded process + final answer. */
function AssistantTurn({
  msgs,
  liveMsg,
  live,
  isLastTurn,
  isStreaming,
  results,
  pending,
  active,
  onRetry,
}: {
  msgs: any[];
  liveMsg: any | null;
  live: boolean;
  isLastTurn: boolean;
  isStreaming: boolean;
  results: Map<string, any>;
  pending: Set<string>;
  active: Map<string, any>;
  onRetry?: () => void;
}) {
  let split = -1;
  msgs.forEach((m, i) => {
    if (hasToolCall(m)) split = i;
  });
  // While a later message is still streaming without answer text, keep it inside the process block.
  const last = msgs[msgs.length - 1];
  if (split >= 0 && last === liveMsg && !hasNonEmptyText(last)) split = msgs.length - 1;
  const process = msgs.slice(0, split + 1);
  const rest = msgs.slice(split + 1);
  const finalMsg = msgs[msgs.length - 1];
  const retry = isLastTurn && !isStreaming ? onRetry : undefined;
  return (
    <>
      {process.length > 0 && (
        <ProcessGroup
          msgs={process}
          liveMsg={liveMsg}
          live={live}
          results={results}
          pending={pending}
          active={active}
          tailError={rest.length === 0 ? finalMsg : undefined}
          onRetry={retry}
        />
      )}
      {rest.map((m, i) => (
        <AssistantMessage
          key={`r${i}`}
          message={m}
          results={results}
          pending={pending}
          live={m === liveMsg}
          onRetry={m === finalMsg ? retry : undefined}
          active={active}
        />
      ))}
    </>
  );
}

/** Render a transcript slice (committed + streaming), grouped by turn. */
export function MessageList({
  messages,
  streaming,
  pendingTools,
  isStreaming,
  onRetry,
  empty,
  activeTools = [],
  tail,
}: {
  messages: any[];
  streaming: any | null;
  pendingTools: string[];
  isStreaming: boolean;
  onRetry?: () => void;
  empty?: ComponentChildren;
  activeTools?: any[];
  /** 收尾动作（复制/下载笔记）：跟着转录末尾，不跟着每条历史消息重复出现。 */
  tail?: ComponentChildren;
}) {
  const active = new Map<string, any>(activeTools.map((t) => [t.id, t]));
  const results = new Map<string, any>();
  for (const m of messages) if (m.role === "toolResult") results.set(m.toolCallId, m);
  const pending = new Set(pendingTools);
  const visible = messages.filter((m) => m.role === "user" || m.role === "assistant");
  if (!visible.length && !streaming && !isStreaming) return <>{empty}</>;

  const all = streaming ? [...visible, streaming] : visible;
  const turns: { user: any | null; assistants: any[] }[] = [];
  for (const m of all) {
    if (m.role === "user") turns.push({ user: m, assistants: [] });
    else {
      if (!turns.length) turns.push({ user: null, assistants: [] });
      turns[turns.length - 1].assistants.push(m);
    }
  }
  const lastTurn = turns.length - 1;
  const lastMsg = all[all.length - 1];
  const showWaiting = isStreaming && !streaming && (!lastMsg || lastMsg.role !== "assistant" || (!hasToolCall(lastMsg) && pending.size === 0));

  return (
    <div class="messages">
      {turns.map((t, ti) => (
        <div class="turn" key={ti}>
          {t.user && <UserMessage message={t.user} />}
          {t.assistants.length > 0 && (
            <div class="msg assistant">
              <AssistantTurn
                msgs={t.assistants}
                liveMsg={streaming}
                live={isStreaming && ti === lastTurn}
                isLastTurn={ti === lastTurn}
                isStreaming={isStreaming}
                results={results}
                pending={pending}
                active={active}
                onRetry={onRetry}
              />
            </div>
          )}
        </div>
      ))}
      {showWaiting && (
        <div class="msg assistant">
          <div class="thinking-live">
            <span class="spinner" /> 正在思考…
          </div>
        </div>
      )}
      {tail}
    </div>
  );
}

/** Where each conversation was left, so a paper switch does not rewind the report. */
const scrollMemory = new Map<string, number>();

/** 从首页预览点页码芯片进来时，右侧报告该停在哪一条结论上。 */
export interface CiteFocus {
  itemKey: string;
  page: number;
  quote: string;
  /** 递增号：连着点两次同一页也要重新定位一次。 */
  nonce: number;
}

const normQuote = (s: string) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * 找到承载这条引用的那一块（列表项/段落/表格行），而不是整条消息：
 * 一次精读报告是一整个 .turn，滚到它开头等于什么都没指出来。
 */
function citeBlock(el: HTMLElement, f: CiteFocus): HTMLElement | null {
  for (const a of Array.from(el.querySelectorAll<HTMLAnchorElement>("a[href^='page:']"))) {
    const href = a.getAttribute("href") || "";
    const page = /^page:\s*(\d+)/i.exec(href)?.[1];
    if (page !== String(f.page)) continue;
    if (f.quote) {
      const raw = /[?&]q=([^&]*)/.exec(href)?.[1] || "";
      let q = "";
      try {
        q = decodeURIComponent(raw.replace(/\+/g, " "));
      } catch {
        q = raw;
      }
      // 芯片里的原句和正文里的是同一串；真对不上时退回「同页即算」，别让人一直等。
      const nq = normQuote(q);
      const want = normQuote(f.quote);
      if (nq && want && !nq.startsWith(want) && !want.startsWith(nq)) continue;
    }
    return (a.closest("li, p, tr, blockquote") as HTMLElement) || a;
  }
  return null;
}

/**
 * Scroll container that sticks to the bottom while content streams in.
 *
 * The first settled render is special: a conversation we have seen before goes back
 * to its own offset, and a freshly seeded close-reading stops at its first core
 * contribution (`anchor`) instead of the bottom of a five-thousand-word report.
 * 首页预览带进来的 `focus` 优先级更高：它知道读者关心的究竟是哪一条结论。
 */
export function AutoScroll({
  children,
  dep,
  ready = true,
  memoryKey = "",
  anchor = "",
  focus = null,
}: {
  children: ComponentChildren;
  dep: any;
  /** False while the transcripts are still loading: do not settle on an empty list. */
  ready?: boolean;
  memoryKey?: string;
  /** Selector for the block a cold report should open on, e.g. "h2". */
  anchor?: string;
  focus?: CiteFocus | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const settled = useRef(false);
  const focused = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !ready) return;
    if (!settled.current) {
      // 转录还在从磁盘里读：等第一条消息到了再定位，否则锚点找不到、直接掉到底部。
      if (!el.querySelector(".turn, .msg")) return;
      // 要锚到某一行时，等那一行真的渲染出来再定位（长报告会分帧补齐）。
      if (anchor && !el.querySelector(anchor)) return;
      settled.current = true;
      const at = memoryKey ? scrollMemory.get(memoryKey) : undefined;
      if (at != null) el.scrollTop = at;
      else {
        const target = anchor ? el.querySelector(anchor) : null;
        el.scrollTop = target
          ? Math.max(0, target.getBoundingClientRect().top - el.getBoundingClientRect().top - 12)
          : el.scrollHeight;
      }
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      return;
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [dep, ready]);
  // 预置会话是异步落盘的：那一条结论还没渲染出来时得等它，但要用 MutationObserver 等——
  // 后台标签页里 requestAnimationFrame 根本不跑，按帧重试等于没重试。
  useEffect(() => {
    const el = ref.current;
    const f = focus;
    if (!el || !f || !f.nonce || focused.current === f.nonce) return;
    const apply = () => {
      const hit = citeBlock(el, f);
      if (!hit) return false;
      focused.current = f.nonce;
      // 定位之后把「跟到底部」关掉，否则下一帧流式更新又把读者拽回全文末尾。
      stick.current = false;
      settled.current = true;
      const top = hit.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      el.scrollTop = Math.max(0, top - Math.round(el.clientHeight / 3));
      hit.classList.add("kb-flash");
      return true;
    };
    if (apply()) return;
    const mo = new MutationObserver(() => apply() && mo.disconnect());
    mo.observe(el, { childList: true, subtree: true });
    const stop = setTimeout(() => mo.disconnect(), 10000); // 报告里真没有这条引用时要有尽头
    return () => {
      mo.disconnect();
      clearTimeout(stop);
    };
  }, [focus?.nonce, ready]);
  return (
    <div
      class="scroll"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        if (memoryKey) scrollMemory.set(memoryKey, el.scrollTop);
      }}
    >
      {children}
    </div>
  );
}

/**
 * The 📌 digest: three bullets are enough to decide whether to read on, so the rest
 * of the contributions stay behind 展开 and every page chip stays clickable.
 */
export function ConclusionDigest({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const items = useMemo(() => splitBullets(text), [text]);
  if (!items.length) return <Markdown text={text} />;
  const shown = open ? items : items.slice(0, 3);
  return (
    <>
      {shown.map((line, i) => (
        <Markdown key={i} text={line} />
      ))}
      {items.length > 3 && (
        <button class="link-btn" onClick={() => setOpen(!open)}>
          {open ? "收起" : `展开其余 ${items.length - 3} 条贡献`}
        </button>
      )}
      <div class="conclusion-hint muted small">💡 下方精读报告里的 p.2 页码都可点击：左侧 PDF 会跳页并圈出原文依据。</div>
    </>
  );
}

export function Composer({
  onSend,
  onStop,
  busy,
  placeholder,
  quote,
  onClearQuote,
  autoFocus,
  footer,
  initial,
  attachments,
  onRemoveAttachment,
  onCapture,
}: {
  onSend: (text: string) => unknown;
  onStop?: () => void;
  busy: boolean;
  placeholder?: string;
  quote?: { text: string; pageLabel: string } | null;
  onClearQuote?: () => void;
  autoFocus?: boolean;
  footer?: ComponentChildren;
  initial?: string;
  attachments?: { dataUrl: string; label: string }[];
  onRemoveAttachment?: (i: number) => void;
  onCapture?: () => void;
}) {
  const hasAttach = !!attachments?.length;
  const [text, setText] = useState(initial || "");
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) ta.current?.focus();
  }, [autoFocus, quote]);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  }, [text]);
  /** One send at a time — and the draft only leaves the box once the run took it. */
  const inflight = useRef(false);
  const send = async () => {
    if (inflight.current || (!text.trim() && !quote && !hasAttach)) return;
    const body = text;
    inflight.current = true;
    try {
      if ((await onSend(body)) === false) return;
      setText((cur) => (cur === body ? "" : cur));
    } catch (e) {
      console.warn("[ScholarPi] 发送失败，草稿已保留", e);
    } finally {
      inflight.current = false;
    }
  };
  return (
    <div class="composer">
      {quote && (
        <div class="quote-chip">
          <span class="quote-text">“{quote.text.length > 140 ? quote.text.slice(0, 140) + "…" : quote.text}”</span>
          {quote.pageLabel && <span class="quote-page">p.{quote.pageLabel}</span>}
          <button class="x" onClick={onClearQuote} title="移除引用">
            ✕
          </button>
        </div>
      )}
      {hasAttach && (
        <div class="attach-row">
          {attachments!.map((a, i) => (
            <div class="attach" key={i} title={a.label}>
              <img src={a.dataUrl} />
              <button class="x" onClick={() => onRemoveAttachment?.(i)} title="移除图片">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div class="input-row">
        {onCapture && (
          <button
            class="capture"
            onClick={onCapture}
            title="框图提问：在 PDF 上框选一块区域，作为图片附在问题里 (⌘/Ctrl+Shift+K)"
            aria-label="框图提问：在 PDF 上框选区域作为图片附件"
          >
            📷
          </button>
        )}
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={placeholder || "输入问题，Enter 发送，Shift+Enter 换行"}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !(e as any).isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        {busy && onStop ? (
          <>
            {text.trim() && (
              <button class="send" onClick={send} title="排队发送（当前回答结束后处理）">
                ↑
              </button>
            )}
            <button class="stop" onClick={onStop} title="停止">
              ■
            </button>
          </>
        ) : (
          <button class="send" onClick={send} disabled={!text.trim() && !quote && !hasAttach} title="发送">
            ↑
          </button>
        )}
      </div>
      {footer}
    </div>
  );
}

/** Live status of the current run: phase, running tools with timers, run totals. */
export function ActivityBar({ snap }: { snap: any }) {
  const busy = !!snap?.isStreaming;
  const now = useTicker(busy);
  if (!busy) return null;
  const tools: any[] = snap.activeTools || [];
  const parts: any[] = snap.streaming?.content || [];
  const last = parts[parts.length - 1];
  let phase: ComponentChildren;
  if (tools.length) {
    phase = tools.map((t) => (
      <div class="act-tool" key={t.id}>
        <span class="spinner" />
        <span class="act-icon">{TOOL_ICONS[t.name] || "🔧"}</span>
        <span class="act-name">{TOOL_LABELS[t.name] || t.name}</span>
        <span class="act-arg">{argSummary(t.name, t.args)}</span>
        <span class="act-time">{fmtSecs(now - t.startedAt)}</span>
      </div>
    ));
  } else if (last?.type === "toolCall") {
    phase = (
      <div class="act-tool">
        <span class="spinner" />
        <span class="act-icon">{TOOL_ICONS[last.name] || "🔧"}</span>
        <span class="act-name">准备调用 {TOOL_LABELS[last.name] || last.name}</span>
        <span class="act-arg">{argSummary(last.name, last.arguments)}</span>
      </div>
    );
  } else if (last?.type === "text") {
    phase = (
      <div class="act-tool">
        <span class="spinner" /> 正在输出回答…
      </div>
    );
  } else if (last?.type === "thinking") {
    phase = (
      <div class="act-tool">
        <span class="spinner" /> 思考中…
      </div>
    );
  } else {
    phase = (
      <div class="act-tool">
        <span class="spinner" /> 等待模型响应…
      </div>
    );
  }
  return (
    <div class="activity">
      <div class="act-main">{phase}</div>
      <div class="act-meta">
        {snap.runStartedAt ? fmtSecs(now - snap.runStartedAt) : ""}
        {snap.runToolCount ? ` · 已完成 ${snap.runToolCount} 个工具调用` : ""}
      </div>
    </div>
  );
}
