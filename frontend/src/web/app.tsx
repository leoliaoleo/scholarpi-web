/**
 * The workbench shell: paper rail · pdf.js reader (+ quick card) · Pi chat.
 *
 * It also owns the two viewer hooks the chat panel needs — opening a paper and
 * showing settings — and waits for the reader to finish loading before the
 * caller jumps to a page, so `[p. 5]` chips work on a cold paper too.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { getItem, paperTitle, prefetchPdf, type Paper } from "../core/paper";
import { gotoPage, paperKey as keyOf, refFromPaperKey, viewerState } from "../core/viewer-state";
import { EXAMPLE_ITEM_KEY } from "../core/presets";
import { clampChatW, NARROW_VW, railCollapsed } from "../shared/layout";
import { statusLabel } from "../shared/errors";
import { PanelApp, QuickApp } from "./chat";
import { LibraryRail } from "./library";
import { SettingsPanel } from "./settings";
import { Pet } from "./pet";
import { getApi, registerViewerHooks, subscribe } from "./api";
import { Viewer } from "./viewer";
import { GraphView } from "./graph";
import { loadGraph, ensurePresetGraph, type GraphData, type GraphNode } from "../core/graph";

const api = getApi();

/** Resolve once the reader shows this paper (or after a timeout). */
function waitViewerReady(key: string, ms = 25000): Promise<void> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = window.setInterval(() => {
      if ((viewerState.paperKey === key && !viewerState.loading) || Date.now() - t0 > ms) {
        window.clearInterval(iv);
        resolve();
      }
    }, 50);
  });
}

export function App() {
  const [openKey, setOpenKey] = useState<string>("");
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [ownKey, setOwnKey] = useState(() => !!api.getSettings().apiKey?.trim());
  const [vw, setVw] = useState(() => window.innerWidth);
  const [collapsed, setCollapsed] = useState(() => railCollapsed(localStorage.getItem("scholarpi.rail"), window.innerWidth));
  const [drawer, setDrawer] = useState(false);
  const [chatW, setChatW] = useState(() =>
    clampChatW(Number(localStorage.getItem("scholarpi.chatw")) || 460, window.innerWidth, railCollapsed(localStorage.getItem("scholarpi.rail"), window.innerWidth)),
  );
  const [health, setHealth] = useState<any>(null);
  const [showQuota, setShowQuota] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [showQuick, setShowQuick] = useState(() => !!api.quick.job);
  useEffect(() => subscribe(api.quick.changes, (j: any) => setShowQuick(!!j)), []);

  /** Narrow desktops (and 125% zoom on a 1280–1440 panel) get the rail as a drawer. */
  const narrow = vw <= NARROW_VW;
  /** Narrow desktops always use the edge strip: the full rail only exists as a drawer. */
  const railEdge = narrow || collapsed;

  useEffect(() => {
    const onResize = () => {
      const w = window.innerWidth;
      const stored = localStorage.getItem("scholarpi.rail");
      setVw(w);
      if (stored !== "1") setCollapsed(railCollapsed(stored, w));
      setDrawer(false);
      setChatW((prev) => clampChatW(prev, w, railCollapsed(stored, w)));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(
    () => subscribe(api.events, (e: any) => e.type === "settings-changed" && setOwnKey(!!api.getSettings().apiKey?.trim())),
    [],
  );

  // Graph mode
  const [mode, setMode] = useState<"reading" | "graph">("reading");
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const openRail = useCallback(() => {
    if (narrow) setDrawer(true);
    else {
      setCollapsed(false);
      localStorage.setItem("scholarpi.rail", "1");
    }
  }, [narrow]);

  const closeRail = useCallback(() => {
    if (narrow) setDrawer(false);
    else {
      setCollapsed(true);
      localStorage.setItem("scholarpi.rail", "0");
    }
  }, [narrow]);

  /** The pet's tour frames the library rail, so it may have to open it first. */
  const expandRail = useCallback(() => {
    setCollapsed(false);
    localStorage.setItem("scholarpi.rail", "1");
  }, []);

  // papers: demo catalogue from the static bundle + the user's library from IndexedDB
  const papers = useMemo(() => api.papers.list(), [tick, openKey]);
  const demo = papers.filter((p) => p.source === "demo");
  const openItem = openKey ? getItem(refFromPaperKey(openKey)) : null;

  const open = useCallback(async (item: Paper, page?: number) => {
    const key = keyOf({ libraryID: item.libraryID, itemKey: item.itemKey });
    setError("");
    setDrawer(false);
    if (mode === "graph") setMode("reading");
    // Ask for the bytes inside the click, before the panels re-render around it.
    prefetchPdf(item);
    setOpenKey(key);
    if (page) {
      await waitViewerReady(key);
      gotoPage(page, false);
    }
  }, [mode]);

  // Load graph data when switching to graph mode
  const switchToGraph = useCallback(async () => {
    setMode("graph");
    setGraphLoading(true);
    try {
      await ensurePresetGraph();
      const data = await loadGraph();
      setGraphData(data);
    } catch (e) {
      console.error("[ScholarPi] Failed to load graph:", e);
    } finally {
      setGraphLoading(false);
    }
  }, []);

  const switchToReading = useCallback(() => {
    setMode("reading");
  }, []);

  const handleGraphNodeClick = useCallback((node: GraphNode) => {
    console.log("[ScholarPi] Graph node clicked:", node);
  }, []);

  const handleGraphNavigate = useCallback(async (itemKey: string, page?: number) => {
    const item = getItem(itemKey);
    if (item) {
      switchToReading();
      await open(item, page);
    }
  }, [open, switchToReading]);

  useEffect(() => {
    registerViewerHooks({
      openPaper: (itemKey: string, page?: number) => {
        const item = getItem(itemKey);
        if (!item) return undefined;
        return open(item, page);
      },
      openSettings: () => setShowSettings(true),
    });
    void api.health().then(setHealth).catch(() => setHealth({ ok: false }));
  }, [open]);

  // imports can come from the rail, the agent's tools or a skill's 一键入库 — refresh on all of them
  useEffect(
    () =>
      subscribe(api.events, (e: any) => {
        if (e.type === "library-changed" || e.type === "skill-imported") refresh();
      }),
    [refresh],
  );

  const addFile = async (file: File) => {
    setBusy(`正在解析 ${file.name}…`);
    setError("");
    try {
      const item = await api.papers.addFile(file);
      setOpenKey(keyOf({ libraryID: item.libraryID, itemKey: item.itemKey }));
      refresh();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy("");
    }
  };

  /** Removing one of the user's own papers also drops it from every collection and card. */
  const removeMine = async (item: Paper) => {
    if (!confirm(`从文献库中移除《${paperTitle(item).slice(0, 30)}…》？批注会保留在浏览器中。`)) return;
    await api.kb.remove(item.itemKey);
    if (openKey.endsWith(`/${item.itemKey}`)) setOpenKey("");
    refresh();
  };

  const splitter = (e: MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = chatW;
    let next = startW;
    const move = (ev: MouseEvent) => {
      next = clampChatW(startW + (startX - ev.clientX), window.innerWidth, collapsed);
      setChatW(next);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
      localStorage.setItem("scholarpi.chatw", String(next));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.classList.add("resizing");
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const f = (e.dataTransfer as DataTransfer)?.files?.[0];
    if (f && /\.pdf$/i.test(f.name)) void addFile(f);
  };

  const status = statusLabel(health, ownKey);
  /** Rendered either inline (wide) or inside the drawer (narrow), never both. */
  const railBody = (
    <div class="rail-body">
      <div class="key-state">
        <button class="status-pill" type="button" aria-expanded={showQuota} title="点击看演示额度说明" onClick={() => setShowQuota(!showQuota)}>
          <span class={`dot ${status.tone}`} />
          <span class="small">{status.text}</span>
        </button>
        <button class="chip" onClick={() => setShowSettings(true)}>
          设置
        </button>
      </div>
      {showQuota && (
        <div class="quota-note">
          <p>{health?.limitNote || "公共演示 Key 与所有访客共享，繁忙时可能让你稍等。"}</p>
          <p class="muted small">这是共享额度，不是个人配额；填入自己的 Key 后请求只计入你自己的账户。</p>
          <button class="link-btn" onClick={() => setShowSettings(true)}>
            配置个人 Key
          </button>
        </div>
      )}
      {health && !health.demoKey && !ownKey && (
        <div class="mini-hint">
          免 Key 体验需配置服务端 Secret <code>DEEPSEEK_API_KEY</code>（本地开发：设置同名环境变量后重启 <code>python backend/app.py</code>）；也可在“设置”中填入自己的 Key。
        </div>
      )}

      <LibraryRail papers={papers} openKey={openKey} onOpen={open} onRemove={removeMine} onChanged={refresh} />
      {busy && (
        <div class="busy">
          <span class="spinner" /> {busy}
        </div>
      )}
      {error && <div class="error-box">{error}</div>}
    </div>
  );

  return (
    <div class="workbench" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <aside class={railEdge ? "rail collapsed" : "rail"}>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (f) void addFile(f);
            (e.target as HTMLInputElement).value = "";
          }}
        />
        <div class="rail-head">
          <div class="logo">π</div>
          {!railEdge && (
            <div class="brand" title="ScholarPi Web —— 科研文献智能体工作台">
              <b>ScholarPi Web</b>
              <span class="muted small">科研文献智能体工作台</span>
            </div>
          )}
          {!railEdge && (
            <button class="icon-btn" title="收起文献栏" aria-label="收起文献栏" onClick={closeRail}>
              «
            </button>
          )}
        </div>

        {!railEdge && railBody}
        {railEdge && (
          <div class="rail-edge">
            <button class="rail-restore" title="打开文献库" aria-label="打开文献库" onClick={openRail}>
              <span class="re-icon">📚</span>
              <span class="re-text">文献库</span>
            </button>
            <button
              class={`icon-btn mode-toggle ${mode === "graph" ? "active" : ""}`}
              title={mode === "graph" ? "切换到文献精读模式" : "切换到知识图谱模式"}
              onClick={() => (mode === "graph" ? switchToReading() : void switchToGraph())}
            >
              {mode === "graph" ? "📖" : "🕸"}
            </button>
            <button class="icon-btn" title="设置" aria-label="设置" onClick={() => setShowSettings(true)}>
              ⚙
            </button>
          </div>
        )}
      </aside>

      {narrow && drawer && (
        <div class="drawer-mask" onMouseDown={(e) => e.target === e.currentTarget && setDrawer(false)}>
          <div class="drawer">
            <div class="drawer-head">
              <b>文献库</b>
              <button class="icon-btn" title="关闭" aria-label="关闭文献库" onClick={() => setDrawer(false)}>
                ×
              </button>
            </div>
            {railBody}
          </div>
        </div>
      )}

      <main class="pane pane-reader">
        {openItem && (
          <div class={mode === "graph" ? "reader-slot slot-off" : "reader-slot"}>
            <Viewer paperKey={openKey} onOpenFile={addFile} active={mode !== "graph"} />
            {showQuick && (
              <div class="quick-dock">
                <QuickApp />
              </div>
            )}
          </div>
        )}
        {mode === "graph" &&
          (graphLoading ? (
            <div class="graph-loading">
              <span class="spinner" /> 加载知识图谱…
            </div>
          ) : graphData ? (
            <GraphView data={graphData} onNodeClick={handleGraphNodeClick} onPaperNavigate={handleGraphNavigate} />
          ) : (
            <div class="graph-empty">图谱数据加载失败</div>
          ))}
        {!openItem && mode !== "graph" && <StartPanel demo={demo} onOpen={open} onUpload={() => fileRef.current?.click()} error={error} />}
      </main>

      <div class="splitter" onMouseDown={splitter} title="拖动调整宽度" />

      <section class="pane pane-chat" style={{ width: `${chatW}px` }}>
        <PanelApp />
      </section>

      <Pet onShowGraph={() => void switchToGraph()} onExpandRail={expandRail} dockOpen={showQuick} />

      {showSettings && (
        <div class="modal" onMouseDown={(e) => e.target === e.currentTarget && setShowSettings(false)}>
          <div class="modal-card">
            <button class="modal-close" onClick={() => setShowSettings(false)}>
              ×
            </button>
            <SettingsPanel />
          </div>
        </div>
      )}
    </div>
  );
}

function StartPanel({ demo, onOpen, onUpload, error }: { demo: Paper[]; onOpen: (i: Paper) => void; onUpload: () => void; error?: string }) {
  const example = demo.find((p) => p.itemKey === EXAMPLE_ITEM_KEY) || demo[0];
  const others = demo.filter((p) => p !== example);
  return (
    <div class="start">
      <div class="start-inner">
        <div class="start-logo">π</div>
        <h1>ScholarPi Web</h1>
        <p class="start-sub">为组会读英文论文：抓住贡献，点击结论核验原文，带走阅读笔记。</p>
        {error && <div class="error-box">{error}</div>}
        <div class="start-cta">
          <button class="primary start-main" disabled={!example} onClick={() => example && onOpen(example)}>
            体验示例精读
          </button>
          <button class="chip start-side" onClick={onUpload}>
            上传自己的 PDF
          </button>
        </div>
        <p class="muted small start-tag">
          示例精读 · 预置内容：{example ? example.title : "内置论文"} 的精读报告与页码证据随站打包，PDF 走本地静态资源，点开不消耗任何模型额度。
        </p>
        {!!others.length && (
          <div class="start-grid">
            {others.map((p) => (
              <button class="start-card" key={p.itemKey} onClick={() => onOpen(p)}>
                <span class="sc-badge">示例精读 · 预置内容</span>
                <span class="sc-title">{p.title}</span>
                <span class="sc-meta">{[p.year, p.venue, p.totalPages ? `${p.totalPages} 页` : ""].filter(Boolean).join(" · ")}</span>
                <span class="sc-abs">{p.abstract.slice(0, 130)}…</span>
              </button>
            ))}
          </div>
        )}
        {!demo.length && <p class="muted small">内置论文来自静态资源 <code>/papers/manifest.json</code>：请先 <code>npm run build</code>，或直接上传自己的 PDF。</p>}
      </div>
    </div>
  );
}
