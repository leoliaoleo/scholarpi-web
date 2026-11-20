import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { clone, getApi, subscribe } from "./api";
import { ActivityBar, AutoScroll, Composer, ConclusionDigest, MessageList, NoteActions, QuickError, Thumb, copyText, textOf } from "./components";
import { Markdown } from "./markdown";
import { arxivIdOf, buildNote, noteFileName, transcriptSections, type NoteSource } from "../shared/note";
import { presetFor } from "../core/presets";
import { SkillBox } from "./skills";

const api = getApi();

// ---------------------------------------------------------------- hooks

interface Snap {
  meta: any;
  messages: any[];
  streaming: any | null;
  isStreaming: boolean;
  pendingTools: string[];
  activeTools: any[];
  runStartedAt: number | null;
  runToolCount: number;
  streamDeltas: number;
  modelId: string;
  thinkingLevel: string;
  version: number;
}

/** Subscribe to a session runtime; messages are cloned only when the committed version changes. */
function useSession(sessionId: string | null): { snap: Snap | null; runtime: any } {
  const [snap, setSnap] = useState<Snap | null>(null);
  const [runtime, setRuntime] = useState<any>(null);
  useEffect(() => {
    setSnap(null);
    setRuntime(null);
    if (!sessionId) return;
    let cancelled = false;
    let off: (() => void) | null = null;
    let lastVersion = -1;
    let lastMessages: any[] = [];
    const apply = (s: any) => {
      if (cancelled) return;
      if (s.version !== lastVersion) {
        lastVersion = s.version;
        lastMessages = clone(s.messages);
      }
      setSnap({
        meta: clone(s.meta),
        messages: lastMessages,
        streaming: clone(s.streaming),
        isStreaming: s.isStreaming,
        pendingTools: [...s.pendingTools],
        activeTools: clone(s.activeTools || []),
        runStartedAt: s.runStartedAt,
        runToolCount: s.runToolCount,
        streamDeltas: s.streamDeltas,
        modelId: s.modelId,
        thinkingLevel: s.thinkingLevel,
        version: s.version,
      });
    };
    api.sessions
      .open(sessionId)
      .then((rt: any) => {
        if (cancelled) return;
        setRuntime(rt);
        apply(rt.snapshot());
        off = subscribe(rt.changes, apply);
      })
      .catch((e: any) => console.error(e));
    return () => {
      cancelled = true;
      off?.();
    };
  }, [sessionId]);
  return { snap, runtime };
}

function useGlobalEvents(fn: (e: any) => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => subscribe(api.events, (e: any) => ref.current(clone(e))), []);
}

function useSettings() {
  const [settings, setSettings] = useState<any>(() => clone(api.getSettings()));
  const [models, setModels] = useState<any[]>(() => clone(api.listModels()));
  useGlobalEvents((e) => {
    if (e.type === "settings-changed") {
      setSettings(clone(api.getSettings()));
      setModels(clone(api.listModels()));
    }
  });
  return { settings, models };
}

/** Handle clicks on links inside rendered markdown. */
function useLinkHandler(paperRef: () => any) {
  return useCallback(
    (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest?.("a");
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("href") || "";
      const ref = paperRef();
      let m = href.match(/^page:\s*(\d+)(?:\?q=([^&]*))?/i);
      if (m && ref) return void api.openPage(ref, Number(m[1]), quoteOf(m[2]));
      m = href.match(/^annotation:([A-Z0-9]{8})/i);
      if (m && ref) return void api.openAnnotation(ref.libraryID, m[1]);
      api.launchURL(href);
    },
    [paperRef],
  );
}

/** `[p. 5](page:5?q=…)`: the verbatim words the answer is based on, URL-encoded. */
function quoteOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw.replace(/\+/g, " ")).trim() || undefined;
  } catch {
    return undefined;
  }
}

function fmtDate(t: number): string {
  const d = new Date(t);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toTimeString().slice(0, 5);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 一条提问之后的所有 assistant 文本合成一节：工具调用的过程性叙述不单独成节。 */
function qaTurns(messages: any[]): { q: string; a: string }[] {
  const out: { q: string; a: string }[] = [];
  let q = "";
  let buf: string[] = [];
  for (const m of messages || []) {
    if (m.role === "user") {
      if (buf.length) out.push({ q, a: buf.join("\n\n") });
      buf = [];
      q = textOf(m);
    } else if (m.role === "assistant") {
      const a = textOf(m).trim();
      if (a) buf.push(a);
    }
  }
  if (buf.length) out.push({ q, a: buf.join("\n\n") });
  return out;
}

/** 笔记头部只写库里真的记着的字段：没有年份就不编年份。 */
function noteSourceOf(itemKey: string, preset: boolean): NoteSource {
  const it = api.papers.get(itemKey);
  return {
    title: it?.title || "未命名文献",
    authors: it?.authors || "",
    year: it?.year || "",
    venue: it?.venue || "",
    arxiv: arxivIdOf(it?.itemKey, it?.url),
    doi: it?.DOI || "",
    origin: it ? (it.source === "demo" ? "演示论文（随站打包）" : it.source === "upload" ? "本地上传 PDF" : "链接导入") : "",
    preset,
  };
}

function reportMarkdown(snap: any, itemKey: string, conclusion: string, preset: boolean): string {
  return buildNote(
    noteSourceOf(itemKey, preset),
    [{ heading: "核心贡献与结论", body: conclusion }, ...transcriptSections(qaTurns(snap?.messages || []))],
    { heading: "精读报告" },
  );
}

/** 最近一次问答：对比矩阵一类的单次产出用它导出，别的内容不会混进来。 */
function answerMarkdown(snap: any, itemKey: string, preset: boolean): string {
  const turns = qaTurns(snap?.messages || []);
  const last = turns[turns.length - 1];
  return buildNote(noteSourceOf(itemKey, preset), last ? transcriptSections([last]) : [], { heading: "回答笔记" });
}

const THINK_LABELS: Record<string, string> = { off: "不思考", minimal: "极简", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最大" };

function ModelPicker({ snap, runtime, models }: { snap: Snap; runtime: any; models: any[] }) {
  const model = models.find((m) => m.id === snap.modelId) || { thinkingLevels: ["off", "high"] };
  const labels = THINK_LABELS;
  return (
    <div class="picker">
      <select value={snap.modelId} onChange={(e) => runtime.setModel((e.target as HTMLSelectElement).value)} title="模型" aria-label="模型">
        {models.map((m) => (
          <option value={m.id}>{m.name}</option>
        ))}
        {!models.some((m) => m.id === snap.modelId) && <option value={snap.modelId}>{snap.modelId}</option>}
      </select>
      <select value={snap.thinkingLevel} onChange={(e) => runtime.setThinking((e.target as HTMLSelectElement).value)} title="思考强度" aria-label="思考强度">
        {model.thinkingLevels.map((l: string) => (
          <option value={l}>思考：{labels[l] || l}</option>
        ))}
      </select>
    </div>
  );
}

/** 模型与思考强度收成二级入口：默认值就能用，不必让两个下拉框常驻首屏。 */
function ModelFold({ snap, runtime, models }: { snap: Snap; runtime: any; models: any[] }) {
  const [open, setOpen] = useState(false);
  const name = models.find((m) => m.id === snap.modelId)?.name || snap.modelId;
  return (
    <div class="model-fold">
      <button class="chip" data-on={open} aria-expanded={open} onClick={() => setOpen(!open)} title="展开可换模型与思考强度（默认值已够用）">
        🧠 {name} · 思考：{THINK_LABELS[snap.thinkingLevel] || snap.thinkingLevel} {open ? "▾" : "▸"}
      </button>
      {open && <ModelPicker snap={snap} runtime={runtime} models={models} />}
    </div>
  );
}

const SUGGESTIONS = [
  "用几句话总结这篇论文的核心贡献",
  "这篇论文的方法是怎么工作的？请分步骤解释",
  "论文的主要实验结果和局限性是什么？",
  "找一找相关工作：我的文献库里和 arXiv 上有哪些相关论文？",
  "帮我高亮论文中最关键的几个结论并加上批注",
];

// ---------------------------------------------------------------- panel

export function PanelApp() {
  const [ctx, setCtx] = useState<any>(() => clone(api.context.get()));
  const [sessions, setSessions] = useState<any[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [quote, setQuote] = useState<{ text: string; pageLabel: string } | null>(null);
  const [attachments, setAttachments] = useState<any[]>([]);
  const [renaming, setRenaming] = useState(false);
  const [showConclusion, setShowConclusion] = useState<boolean | null>(null);
  const [toast, setToast] = useState<{ text: string; key?: string; libraryID?: number; icon?: string } | null>(null);
  const [health, setHealth] = useState<any>(null);
  const { settings, models } = useSettings();
  const { snap, runtime } = useSession(activeId);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const onLink = useLinkHandler(() => ctxRef.current?.ref);

  useEffect(() => subscribe(api.context.changes, (c: any) => setCtx(clone(c))), []);
  useEffect(() => {
    void api.health().then(setHealth);
  }, []);

  const loadSessions = useCallback(async (c: any, pickActive: boolean) => {
    if (!c) {
      setSessions([]);
      setActiveId(null);
      return;
    }
    const seeded = await api.seedPreset(c.ref);
    const list = clone(await api.sessions.list(c.ref));
    setSessions(list);
    if (pickActive) setActiveId(seeded || (await api.sessions.activeSessionId(c.ref, true)));
  }, []);

  useEffect(() => {
    void loadSessions(ctx, true);
  }, [ctx?.ref?.libraryID, ctx?.ref?.itemKey]);

  useGlobalEvents((e) => {
    const c = ctxRef.current;
    if (e.type === "sessions-changed" && c && e.itemKey === c.ref.itemKey) void loadSessions(c, false);
    if (e.type === "annotation-created" && c && e.itemKey === c.ref.itemKey) {
      setToast({ text: `已创建批注（第 ${e.page} 页）`, key: e.key, libraryID: e.libraryID });
      setTimeout(() => setToast(null), 5000);
    }
    if (e.type === "model-switched" && c && e.itemKey === c.ref.itemKey) {
      setToast({ text: `当前模型不能看图，已切换到 ${e.model}` });
      setTimeout(() => setToast(null), 5000);
    }
    if (e.type === "note-created" && c && e.itemKey === c.ref.itemKey) {
      setToast({ text: "已保存为文献笔记", key: e.key, libraryID: e.libraryID });
      setTimeout(() => setToast(null), 4000);
    }
  });

  /** The 划词 / 框图 card hands a quote over to the conversation. */
  useGlobalEvents((e) => {
    if (e.type === "insert-quote" && e.text) setQuote({ text: String(e.text), pageLabel: e.pageLabel ? String(e.pageLabel) : "" });
    if (e.type === "open-session" && e.sessionId) setActiveId(String(e.sessionId));
  });

  const selectSession = async (id: string) => {
    setActiveId(id);
    if (ctx) await api.sessions.setActive(ctx.ref, id);
  };
  const newSession = async () => {
    if (!ctx) return;
    const meta = await api.sessions.create(ctx.ref);
    await loadSessions(ctx, false);
    setActiveId(meta.id);
  };
  const deleteSession = async () => {
    if (!activeId || !ctx) return;
    if (!window.confirm("删除当前会话？此操作不可撤销。")) return;
    await api.sessions.remove(activeId);
    await loadSessions(ctx, true);
  };
  const capture = async () => {
    if (ctx?.source !== "reader") {
      setToast({ text: "请先在阅读器中打开这篇论文的 PDF" });
      setTimeout(() => setToast(null), 3500);
      return;
    }
    const img = clone(await api.captureRegion());
    if (img) setAttachments((a) => [...a, img]);
  };
  const notify = useCallback((text: string, icon = "💡") => {
    setToast({ text, icon });
    setTimeout(() => setToast(null), 4500);
  }, []);
  /** A skill's prompt goes in as-is: no pending 划词 quote or screenshot should ride along. */
  const sendPrompt = (text: string) => {
    if (runtime) void runtime.send(text);
  };
  /** False = the run never took it, so the composer keeps the draft on screen. */
  const send = (text: string): void | false => {
    if (!runtime) {
      notify("会话还在准备中，这条问题保留在输入框里，稍后再发。");
      return false;
    }
    let content = text.trim();
    if (attachments.length) {
      const pages = [...new Set(attachments.map((a) => a.pageLabel))].join("、");
      const images = attachments.map((a) => ({ type: "image", data: a.data, mimeType: a.mimeType }));
      setAttachments([]);
      void runtime.send(`${content || "请结合论文解释这张截图。"}\n\n（截图来自第 ${pages} 页）`, images);
      return;
    }
    if (quote) {
      content = `> ${quote.text.replace(/\s+/g, " ").trim()}\n${quote.pageLabel ? `（第 ${quote.pageLabel} 页）\n` : ""}\n${content || "请解释这段内容。"}`;
      setQuote(null);
    }
    void runtime.send(content);
  };

  if (!ctx) {
    return (
      <div class="app">
        <div class="empty">
          <div class="empty-logo">π</div>
          <p>在左侧打开一篇文献（内置演示论文、本地 PDF 或 arXiv 链接），即可开始文章级对话。</p>
          <button class="link-btn" onClick={() => api.openSettings()}>
            设置
          </button>
        </div>
      </div>
    );
  }

  const active = sessions.find((s) => s.id === activeId) || snap?.meta;
  const conclusion = snap?.meta?.conclusion || active?.conclusion || "";
  // 有结论就默认展开：首访者要在第一屏看到核心贡献，而不是一个 📌 图标。
  const openConclusion = showConclusion ?? !!conclusion;
  // 预置精读是一篇已经写完的报告：首屏停在第一条核心贡献的开头，而不是全文末尾。
  // 认结论而不是认标题——会话被重命名、preset 文案微调都不该让首屏退回全文末尾。
  const presetReport = !!activeId && !!conclusion && conclusion === presetFor(ctx.ref.itemKey)?.conclusion;

  return (
    <div class="app" onClick={onLink as any}>
      <div class="topbar">
        {renaming && active ? (
          <input
            class="rename"
            autoFocus
            defaultValue={active.title}
            onKeyDown={async (e) => {
              const v = (e.target as HTMLInputElement).value.trim();
              if (e.key === "Enter" && v) {
                await api.sessions.rename(active.id, v);
                setRenaming(false);
              } else if (e.key === "Escape") setRenaming(false);
            }}
            onBlur={() => setRenaming(false)}
          />
        ) : (
          <select class="session-select" value={activeId || ""} onChange={(e) => selectSession((e.target as HTMLSelectElement).value)}>
            {sessions.map((s) => (
              <option value={s.id}>
                {s.title || "新会话"} · {fmtDate(s.updated)}
              </option>
            ))}
          </select>
        )}
        <button class="icon-btn" title="新建会话" aria-label="新建会话" onClick={newSession}>
          ＋
        </button>
        <button class="icon-btn" title="重命名会话" aria-label="重命名会话" onClick={() => setRenaming(true)}>
          ✎
        </button>
        <button class="icon-btn" title={conclusion ? "展开/收起会话结论" : "暂无结论"} aria-label="会话结论" data-active={String(openConclusion)} onClick={() => setShowConclusion(!openConclusion)}>
          📌
        </button>
        <button class="icon-btn" title="删除当前会话" aria-label="删除当前会话" onClick={deleteSession}>
          🗑
        </button>
        <button class="icon-btn" title="设置：模型、Key、MCP 与检索" aria-label="打开设置" onClick={() => api.openSettings()}>
          ⚙
        </button>
      </div>
      {openConclusion && (
        <div class="conclusion">
          <div class="conclusion-title">📌 核心贡献与结论（{snap?.meta?.paperTitle || active?.paperTitle || "本文"}）</div>
          {conclusion ? <ConclusionDigest text={conclusion} /> : <div class="muted">对话后会自动生成结论。</div>}
          {!!conclusion && (
            <NoteActions
              label="精读报告"
              build={() => reportMarkdown(snap, ctx.ref.itemKey, conclusion, presetReport)}
              file={() => noteFileName(noteSourceOf(ctx.ref.itemKey, presetReport), "精读报告")}
            />
          )}
        </div>
      )}
      {!settings.apiKey && health && !health.demoKey && (
        <div class="banner">
          免 Key 体验需服务端配置 Secret <code>DEEPSEEK_API_KEY</code>；也可填入自己的 Key。
          <button class="link-btn" onClick={() => api.openSettings()}>
            打开设置
          </button>
        </div>
      )}
      {!settings.apiKey && health?.demoKey && <div class="banner info">演示模式可用 · 共享额度有速率限制。<button class="link-btn" onClick={() => api.openSettings()}>配置个人 Key</button></div>}
      <AutoScroll
        dep={snap ? `${snap.version}:${textOf(snap.streaming).length}:${JSON.stringify(snap.streaming?.content?.length)}` : 0}
        ready={!!snap}
        memoryKey={activeId || ""}
        anchor={presetReport ? "h2" : ""}
      >
        {snap ? (
          <MessageList
            messages={snap.messages}
            streaming={snap.streaming}
            pendingTools={snap.pendingTools}
            activeTools={snap.activeTools}
            isStreaming={snap.isStreaming}
            onRetry={() => runtime?.retry()}
            tail={
              !snap.isStreaming && snap.messages.some((m: any) => m.role === "assistant") ? (
                <NoteActions
                  label="本条回答"
                  build={() => answerMarkdown(snap, ctx.ref.itemKey, presetReport)}
                  file={() => noteFileName(noteSourceOf(ctx.ref.itemKey, presetReport), "回答笔记")}
                />
              ) : null
            }
            empty={
              <div class="empty small">
                <div class="paper-title">{ctx.title}</div>
                <p class="muted">Agent 会按需检索、阅读论文全文，可访问工作区文献、历史会话、网络、arXiv 与 Google Scholar，并能直接在 PDF 中创建高亮与批注。</p>
                <div class="suggestions">
                  {SUGGESTIONS.map((s) => (
                    <button class="suggestion" onClick={() => send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            }
          />
        ) : (
          <div class="empty small">
            <span class="spinner" />
          </div>
        )}
      </AutoScroll>
      {toast && (
        <div class="toast" onClick={() => toast.key && api.openAnnotation(toast.libraryID ?? 1, toast.key)}>
          {toast.icon ?? "🖍"} {toast.text}
          {toast.key && <span class="muted"> · 点击查看</span>}
        </div>
      )}
      <ActivityBar snap={snap} />
      <SkillBox ctx={ctx} runtime={runtime} busy={!!snap?.isStreaming} onSend={sendPrompt} notify={(t) => notify(t, "🧪")} />
      <Composer
        busy={!!snap?.isStreaming}
        onSend={send}
        onStop={() => runtime?.abort()}
        quote={quote}
        onClearQuote={() => setQuote(null)}
        autoFocus={!!quote || attachments.length > 0}
        attachments={attachments.map((a) => ({ dataUrl: a.dataUrl, label: `第 ${a.pageLabel} 页截图` }))}
        onRemoveAttachment={(i) => setAttachments((a) => a.filter((_, j) => j !== i))}
        onCapture={ctx?.source === "reader" ? capture : undefined}
        footer={snap && runtime ? <ModelFold snap={snap} runtime={runtime} models={models} /> : null}
      />
    </div>
  );
}

// ---------------------------------------------------------------- quick card

export function QuickApp() {
  const [job, setJob] = useState<any>(() => clone(api.quick.job));
  useEffect(() => subscribe(api.quick.changes, (j: any) => setJob(clone(j))), []);
  const { snap, runtime } = useSession(job?.sessionId || null);
  const jobRef = useRef(job);
  jobRef.current = job;
  const onLink = useLinkHandler(() => jobRef.current?.paper);
  const [saved, setSaved] = useState<string | null>(null);
  const [copied, setCopied] = useState("");
  useEffect(() => setSaved(null), [job?.id]);
  useEffect(() => setCopied(""), [job?.id]);

  const slice = useMemo(() => {
    if (!snap || job?.startIndex == null) return [];
    return snap.messages.slice(job.startIndex);
  }, [snap?.version, job?.startIndex, job?.sessionId]);

  if (!job) return <div class="app quick"><div class="empty small muted">选中文本后选择操作</div></div>;

  const lastAssistant = [...slice].reverse().find((m) => m.role === "assistant" && textOf(m).trim());
  const resultText = job.kind === "translate" ? job.output : textOf(lastAssistant);
  const imageActions: any[] = job.kind === "image" ? clone(api.imageActions()) : [];
  const busy = job.kind === "translate" ? job.status === "running" : !!snap?.isStreaming;

  const save = async () => {
    try {
      const key = await api.quick.saveAsAnnotation(resultText);
      setSaved(key);
    } catch (e: any) {
      window.alert(String(e?.message || e));
    }
  };
  /** 复制被浏览器拒绝时改下载 .md：小卡的回答同样值得留档，不能只留一个 no-op。 */
  const copyAnswer = async () => {
    if (await copyText(resultText)) return setCopied("已复制到剪贴板");
    const src = noteSourceOf(String(job.paper?.itemKey || ""), false);
    api.kb.download(noteFileName(src, "回答笔记"), buildNote(src, [{ heading: "回答", body: resultText }], { heading: "回答笔记" }), "text/markdown");
    setCopied("剪贴板不可用，已下载 .md");
  };

  return (
    <div class="app quick" onClick={onLink as any}>
      <AutoScroll dep={`${job.output.length}:${snap?.version}:${textOf(snap?.streaming).length}`}>
        {job.kind === "image" && job.image ? (
          <div class="image-src">
            <Thumb img={job.image} />
            <div class="muted small">
              第 {job.image.pageLabel} 页{job.annotationKey ? " · 图片批注" : " · 框选区域"}
            </div>
          </div>
        ) : (
          <div class="quote-src" title={job.selection.text}>
            “{job.selection.text.length > 220 ? job.selection.text.slice(0, 220) + "…" : job.selection.text}”
          </div>
        )}
        {job.kind === "image" && job.status === "input" && (
          <div class="image-actions">
            {imageActions.map((a) => (
              <button class="suggestion" onClick={() => void api.quick.runImage(a.prompt)}>
                {a.label}
              </button>
            ))}
            <div class="muted hint">或在下方输入你的问题</div>
          </div>
        )}
        {job.kind === "translate" ? (
          <div class="messages">
            <div class="msg assistant">
              {job.output ? <Markdown text={job.output} /> : job.status === "running" && <div class="thinking-live"><span class="spinner" /> 翻译中…</div>}
              {job.status === "error" && <QuickError error={String(job.error || "")} />}
            </div>
          </div>
        ) : job.status === "error" ? (
          <QuickError error={String(job.error || "")} />
        ) : snap ? (
          <MessageList
            messages={slice.filter((m: any, i: number) => !(i === 0 && m.role === "user"))}
            streaming={snap.streaming}
            pendingTools={snap.pendingTools}
            activeTools={snap.activeTools}
            isStreaming={snap.isStreaming}
            onRetry={() => runtime?.retry()}
          />
        ) : job.kind === "ask" && job.status === "input" ? (
          <div class="muted hint">针对这段文字想问什么？</div>
        ) : job.kind === "image" && job.status === "input" ? null : (
          <div class="thinking-live">
            <span class="spinner" /> 准备中…
          </div>
        )}
      </AutoScroll>
      {job.kind === "image" && !resultText && !busy && !job.annotationKey && (
        <div class="quick-actions">
          <button class="chip" onClick={save} disabled={!!saved}>
            {saved ? "✓ 已保存为图片批注" : "保存为图片批注"}
          </button>
        </div>
      )}
      {resultText && !busy && (
        <div class="quick-actions">
          <button class="chip" onClick={() => void copyAnswer()} title="复制这段回答；浏览器拦住剪贴板时改为下载 .md" aria-label="复制这段回答">
            {copied ? copied : "复制"}
          </button>
          <button class="chip" onClick={save} disabled={!!saved}>
            {saved ? "✓ 已保存为批注" : job.kind === "image" ? (job.annotationKey ? "写入图片批注评论" : "保存为图片批注") : "保存为高亮批注"}
          </button>
        </div>
      )}
      {job.kind !== "translate" && <ActivityBar snap={snap} />}
      {job.kind !== "translate" && (
        <Composer
          busy={busy}
          onSend={async (t) => {
            await api.quick.submitAsk(t);
            // submitAsk 把失败只写进 job，这里返回 false 让草稿留在输入框。
            return api.quick.job?.status === "error" ? false : undefined;
          }}
          onStop={() => runtime?.abort()}
          autoFocus={job.kind === "ask" || job.kind === "image"}
          placeholder={(job.kind === "ask" || job.kind === "image") && !job.sessionId ? "输入问题，Enter 发送" : "继续追问…"}
        />
      )}
    </div>
  );
}
