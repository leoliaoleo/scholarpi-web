/**
 * The workbench shell: paper rail · pdf.js reader (+ quick card) · Pi chat.
 *
 * It also owns the two viewer hooks the chat panel needs — opening a paper and
 * showing settings — and waits for the reader to finish loading before the
 * caller jumps to a page, so `[p. 5]` chips work on a cold paper too.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { getItem, paperTitle, type Paper } from "../core/paper";
import { gotoPage, paperKey as keyOf, refFromPaperKey, viewerState } from "../core/viewer-state";
import { PanelApp, QuickApp } from "./chat";
import { SettingsPanel } from "./settings";
import { getApi, registerViewerHooks, subscribe } from "./api";
import { Viewer } from "./viewer";

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

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // papers: demo catalogue from Flask + the user's library from IndexedDB
  const papers = useMemo(() => api.papers.list(), [tick, openKey]);
  const demo = papers.filter((p) => p.source === "demo");
  const mine = papers.filter((p) => p.source !== "demo");
  const openItem = openKey ? getItem(refFromPaperKey(openKey)) : null;

  const open = useCallback(async (item: Paper, page?: number) => {
    const key = keyOf({ libraryID: item.libraryID, itemKey: item.itemKey });
    setError("");
    setOpenKey(key);
    if (page) {
      await waitViewerReady(key);
      gotoPage(page, false);
    }
  }, []);

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

  const addUrl = async (url: string) => {
    if (!url.trim()) return;
    setBusy("正在获取文献…");
    setError("");
    try {
      const item = await api.papers.addUrl(url.trim());
      setOpenKey(keyOf({ libraryID: item.libraryID, itemKey: item.itemKey }));
      refresh();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy("");
    }
  };

  const remove = async (item: Paper) => {
    if (!confirm(`从文献库中移除《${paperTitle(item).slice(0, 30)}…》？批注会保留在浏览器中。`)) return;
    await api.papers.remove(item.itemKey);
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
        <div class="rail-head">
          <div class="logo">π</div>
          {!collapsed && (
            <div class="brand">
              <b>ScholarPi Web</b>
              <span class="muted small">浏览器端科研文献智能体</span>
            </div>
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
                title={health?.demoKey ? "后端演示 Key 可用" : "未配置演示 Key"}
              />
              <span class="small">
                {health?.demoKey ? "演示 Key 可用" : health?.ok ? "需填入自己的 Key" : "后端未连接"}
              </span>
              <button class="chip" onClick={() => setShowSettings(true)}>
                设置
              </button>
            </div>
            {health && !health.demoKey && (
              <div class="mini-hint">
                评委免 Key 体验需在后端设置环境变量 <code>DEEPSEEK_API_KEY</code>；也可在“设置”中填入自己的 Key。
              </div>
            )}

            <div class="add-row">
              <button class="primary" onClick={() => fileRef.current?.click()}>
                上传 PDF
              </button>
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
            </div>
            <UrlAdder onAdd={addUrl} busy={!!busy} />
            {busy && (
              <div class="busy">
                <span class="spinner" /> {busy}
              </div>
            )}
            {error && <div class="error-box">{error}</div>}

            <PaperGroup title="我的文献" items={mine} openKey={openKey} onOpen={open} onRemove={remove} empty="上传 PDF 或粘贴 arXiv 链接" />
            <PaperGroup
              title="演示论文"
              items={demo}
              openKey={openKey}
              onOpen={open}
              empty={demo.length ? "" : "未取到内置论文：请确认 Flask 后端已启动（python backend/app.py）"}
            />
          </div>
        )}
      </aside>

      <main class="pane pane-reader">
        {openItem ? (
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

function UrlAdder({ onAdd, busy }: { onAdd: (url: string) => void; busy: boolean }) {
  const [url, setUrl] = useState("");
  return (
    <form
      class="url-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (url.trim() && !busy) {
          onAdd(url);
          setUrl("");
        }
      }}
    >
      <input value={url} placeholder="arXiv ID / 链接，如 1706.03762" onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
      <button class="icon-btn" type="submit" title="添加" disabled={busy}>
        ＋
      </button>
    </form>
  );
}

function PaperGroup({
  title,
  items,
  openKey,
  onOpen,
  onRemove,
  empty,
}: {
  title: string;
  items: Paper[];
  openKey: string;
  onOpen: (item: Paper) => void;
  onRemove?: (item: Paper) => void;
  empty?: string;
}) {
  return (
    <div class="group">
      <div class="group-title">
        {title}
        <span class="muted">{items.length}</span>
      </div>
      {items.map((p) => (
        <PaperCard key={p.itemKey} item={p} active={openKey.endsWith(`/${p.itemKey}`)} onOpen={onOpen} onRemove={onRemove} />
      ))}
      {!items.length && empty && <div class="group-empty">{empty}</div>}
    </div>
  );
}

function PaperCard({ item, active, onOpen, onRemove }: { item: Paper; active: boolean; onOpen: (i: Paper) => void; onRemove?: (i: Paper) => void }) {
  const meta = [item.year, item.venue, item.totalPages ? `${item.totalPages} 页` : ""].filter(Boolean).join(" · ");
  return (
    <button class={active ? "paper active" : "paper"} onClick={() => onOpen(item)} title={item.title}>
      <span class="p-title">{item.title}</span>
      {item.authors && <span class="p-meta">{item.authors.split(",").slice(0, 2).join(", ")}{item.authors.split(",").length > 2 ? " 等" : ""}</span>}
      {meta && <span class="p-meta muted">{meta}</span>}
      {onRemove && (
        <span
          class="p-del"
          role="button"
          title="移除"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(item);
          }}
        >
          ×
        </span>
      )}
    </button>
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
        {!demo.length && <p class="muted small">内置论文由后端 <code>/api/demo-papers</code> 提供：请先运行 <code>python backend/app.py</code>。</p>}
      </div>
    </div>
  );
}
