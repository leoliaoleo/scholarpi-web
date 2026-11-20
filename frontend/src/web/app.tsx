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
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("scholarpi.rail") === "0" || window.innerWidth < 1000,
  );
  const [chatW, setChatW] = useState(() => Math.min(Number(localStorage.getItem("scholarpi.chatw")) || 460, window.innerWidth * 0.48));
  const [health, setHealth] = useState<any>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [showQuick, setShowQuick] = useState(() => !!api.quick.job);
  useEffect(() => subscribe(api.quick.changes, (j: any) => setShowQuick(!!j)), []);

  // Graph mode
  const [mode, setMode] = useState<"reading" | "graph">("reading");
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

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
    // Ask for the bytes inside the click, before the panels re-render around it.
    prefetchPdf(item);
    setOpenKey(key);
    if (page) {
      await waitViewerReady(key);
      gotoPage(page, false);
    }
  }, []);

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
    const move = (ev: MouseEvent) => {
      const next = Math.min(Math.max(startW + (startX - ev.clientX), 320), Math.min(760, window.innerWidth - 520));
      setChatW(next);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
      localStorage.setItem("scholarpi.chatw", String(chatW));
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

  return (
    <div class="workbench" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <aside class={collapsed ? "rail collapsed" : "rail"}>
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
          {!collapsed && (
            <div class="brand" title="ScholarPi Web —— 科研文献智能体工作台">
              <b>ScholarPi Web</b>
              <span class="muted small">科研文献智能体工作台</span>
            </div>
          )}
          {!collapsed && (
            <button
              class={`icon-btn mode-toggle ${mode === "graph" ? "active" : ""}`}
              title={mode === "graph" ? "切换到文献精读模式" : "切换到知识图谱模式"}
              onClick={() => (mode === "graph" ? switchToReading() : void switchToGraph())}
            >
              {mode === "graph" ? "📖" : "🕸"}
            </button>
          )}
          <button
            class="icon-btn"
            title={collapsed ? "展开文献栏" : "收起文献栏"}
            onClick={() => {
              setCollapsed(!collapsed);
              localStorage.setItem("scholarpi.rail", collapsed ? "1" : "0");
            }}
          >
            {collapsed ? "»" : "«"}
          </button>
        </div>

        {!collapsed && (
          <div class="rail-body">
            <div class="key-state">
              <span
                class={`dot ${health?.demoKey ? "ok" : health?.ok ? "warn" : "off"}`}
                title={health?.demoKey ? "服务端演示 Key 可用" : "未配置演示 Key"}
              />
              <span class="small">
                {health?.demoKey ? "演示 Key 可用" : health?.ok ? "需填入自己的 Key" : "服务端未连接"}
              </span>
              <button class="chip" onClick={() => setShowSettings(true)}>
                设置
              </button>
            </div>
            {health && !health.demoKey && (
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
        )}
      </aside>

      <main class="pane pane-reader">
        {mode === "graph" ? (
          graphLoading ? (
            <div class="graph-loading">
              <span class="spinner" /> 加载知识图谱...
            </div>
          ) : graphData ? (
            <GraphView data={graphData} onNodeClick={handleGraphNodeClick} onPaperNavigate={handleGraphNavigate} />
          ) : (
            <div class="graph-empty">图谱数据加载失败</div>
          )
        ) : openItem ? (
          <>
            <Viewer paperKey={openKey} onOpenFile={addFile} />
            {showQuick && (
              <div class="quick-dock">
                <QuickApp />
              </div>
            )}
          </>
        ) : (
          <StartPanel demo={demo} onOpen={open} onUpload={() => fileRef.current?.click()} error={error} />
        )}
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
  return (
    <div class="start">
      <div class="start-inner">
        <div class="start-logo">π</div>
        <h1>ScholarPi Web</h1>
        <p class="muted">上传一篇 PDF，或打开一篇内置论文，右侧的 Pi 会渐进式精读它：先读结构、再定位段落、看到图表，并把结论写成可跳转的页码引用。</p>
        {error && <div class="error-box">{error}</div>}
        <div class="start-grid">
          {demo.map((p) => (
            <button class="start-card" key={p.itemKey} onClick={() => onOpen(p)}>
              <span class="sc-title">{p.title}</span>
              <span class="sc-meta">{[p.year, p.venue, p.totalPages ? `${p.totalPages} 页` : ""].filter(Boolean).join(" · ")}</span>
              <span class="sc-abs">{p.abstract.slice(0, 130)}…</span>
            </button>
          ))}
          <button class="start-card upload" onClick={onUpload}>
            <span class="sc-title">上传自己的 PDF</span>
            <span class="sc-meta">仅存于本机浏览器（IndexedDB）</span>
          </button>
        </div>
        {!demo.length && <p class="muted small">内置论文来自静态资源 <code>/papers/manifest.json</code>：请先 <code>npm run build</code>，或直接上传自己的 PDF。</p>}
      </div>
    </div>
  );
}
