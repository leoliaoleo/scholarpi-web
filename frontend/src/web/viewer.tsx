/**
 * Left pane of the workbench: a pdf.js reader with a selectable text layer.
 *
 * On top of plain rendering it carries the two interactions the desktop plugin
 * was known for — 划词提问 (selection toolbar) and 框图提问 (drag a box around a
 * figure) — plus the highlight overlay the agent writes into.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";
import { getSettings } from "../core/config";
import { globalEvents } from "../core/events";
import { getAnnotation, listAnnotations, saveSelectionAsHighlight, type Annotation } from "../core/annotate";
import { ensurePdf, getItem, type Paper } from "../core/paper";
import { safeUrl } from "../core/library-util";
import { EXAMPLE_ITEM_KEY } from "../core/presets";
import { classifyError } from "../shared/errors";
import { getDoc, getPage, getPageData } from "../core/reader";
import { getRangeRects, type PdfChar } from "../core/text";
import { renderActiveRegion } from "../core/vision";
import { gotoPage, refFromPaperKey, setViewerState, viewerCommands, viewerState, type ViewerCommand } from "../core/viewer-state";
import { registerViewerHooks, refreshContext, subscribe, getApi, type ViewerHooks } from "./api";
import { Markdown } from "./markdown";

const api = getApi();

/** Per rendered page: the char model the selection maps back into, plus the viewport. */
interface PageInfo {
  chars: PdfChar[];
  viewBox: number[];
  viewport: PageViewport;
}

const pageInfos = new Map<string, PageInfo>();

function infoKey(docKey: string, index: number): string {
  return `${docKey}:${index}`;
}

interface Box {
  rects: number[][];
  color: string;
  kind: Annotation["type"] | "agent";
  ann?: Annotation;
}

export interface ViewerProps {
  /** `${libraryID}/${itemKey}` of the paper to show, null = drop zone. */
  paperKey: string | null;
  onOpenFile?: (file: File) => void;
  /** False while the graph covers this pane: keep the scroll offset for the way back. */
  active?: boolean;
}

/** Reading position per paper, kept across a 阅读 → 图谱 → 阅读 round trip. */
const scrollMemory = new Map<string, number>();

export function Viewer({ paperKey, onOpenFile, active = true }: ViewerProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState("");
  const [scale, setScale] = useState<number>(() => Number(localStorage.getItem("scholarpi.zoom")) || 1.35);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [pulse, setPulse] = useState<{ pageIndex: number; rects: number[][]; keep: boolean } | null>(null);
  const [sel, setSel] = useState<{ info: SelInfo; left: number; top: number } | null>(null);
  const [regionOn, setRegionOn] = useState(false);
  const [busy, setBusy] = useState<"" | "download" | "parse">("");
  const [dl, setDl] = useState<{ r: number; t: number } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [openAnn, setOpenAnn] = useState<{ ann: Annotation; left: number; top: number } | null>(null);
  const regionResolve = useRef<((img: any) => void) | null>(null);
  /** A `[p. x]` click that arrived before the PDF was on screen, applied the moment it is. */
  const pendingJump = useRef<{ page: number; smooth: boolean } | null>(null);

  const item = useMemo(() => (paperKey ? getItem(refFromPaperKey(paperKey)) : null), [paperKey]);
  const docKey = paperKey || "";

  // ---------------------------------------------------------------- load
  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setError("");
    setSel(null);
    setPulse(null);
    setOpenAnn(null);
    pendingJump.current = null;
    for (const k of [...pageInfos.keys()]) if (k.startsWith(`${docKey}:`)) pageInfos.delete(k);
    if (!docKey || !item) {
      setViewerState({ paperKey: docKey || null, currentPage: 1, pageCount: 0, loading: false });
      refreshContext();
      void listAnnotationsFallback(null).then(setAnnotations);
      return;
    }
    setViewerState({ paperKey: docKey, loading: true });
    // The chat panel follows the selection, not the parse: seed/load this paper's
    // session now so a slow or failed PDF never leaves it on the previous paper.
    refreshContext();
    setBusy("download");
    setDl(null);
    let shown = -1;
    const onProgress = (r: number, t: number) => {
      if (cancelled) return;
      const step = t ? Math.round((r / t) * 100) : Math.floor(r / 131_072);
      if (step === shown && r !== t) return;
      shown = step;
      setDl({ r, t });
    };
    (async () => {
      try {
        const ok = await ensurePdf(item, onProgress);
        if (cancelled) return;
        if (!ok) throw new Error("这篇文献没有可用的 PDF 文件");
        setBusy("parse");
        const d = await getDoc(docKey);
        if (cancelled) return;
        if (!d) throw new Error("PDF 解析失败");
        setDoc(d);
        setViewerState({ pageCount: d.numPages, currentPage: 1, loading: false });
        if (!localStorage.getItem("scholarpi.zoom")) await fitWidth(d);
        setAnnotations(await listAnnotationsFallback(item));
      } catch (e: any) {
        if (!cancelled) {
          setError(String(e?.message || e));
          setViewerState({ loading: false });
          refreshContext();
        }
      } finally {
        if (!cancelled) setBusy("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docKey, item?.itemKey, attempt]);

  // annotations refresh whenever the agent (or the user) writes one
  useEffect(() => {
    if (!item) return;
    let alive = true;
    const reload = () => void listAnnotationsFallback(item).then((a) => alive && setAnnotations(a));
    reload();
    const offs = ["annotation-created", "annotation-updated", "annotation-deleted"].map((t) =>
      globalEvents.on((e) => {
        if (e.type === t && (!e.itemKey || e.itemKey === item.itemKey)) reload();
      }),
    );
    return () => {
      alive = false;
      offs.forEach((off) => off());
    };
  }, [item?.itemKey]);

  // ---------------------------------------------------------------- reader commands
  useEffect(() => {
    const onCmd = (c: ViewerCommand) => {
      if (c.type === "goto") {
        if (doc && viewerState.paperKey === docKey) scrollToPage(c.page, c.smooth !== false);
        else pendingJump.current = { page: c.page, smooth: c.smooth !== false };
      } else if (c.type === "highlight") setPulse({ pageIndex: c.pageIndex, rects: c.rects, keep: !!c.keep });
      else if (c.type === "clear-highlight") setPulse(null);
    };
    return subscribe(viewerCommands, onCmd);
  }, [doc, docKey]);

  // The pages exist only after the first render, so jump/restore one frame later.
  useEffect(() => {
    if (!doc || !active) return;
    const jump = pendingJump.current;
    pendingJump.current = null;
    const raf = requestAnimationFrame(() => {
      const el = scroller.current;
      if (!el) return;
      if (jump) scrollToPage(jump.page, jump.smooth);
      else {
        const at = scrollMemory.get(docKey);
        if (at && Math.abs(el.scrollTop - at) > 4) el.scrollTop = at;
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [doc, active, docKey]);

  useEffect(() => {
    if (!pulse || pulse.keep) return;
    const t = setTimeout(() => setPulse(null), 8000);
    return () => clearTimeout(t);
  }, [pulse]);

  // ---------------------------------------------------------------- capture hook (chat 📷 button)
  useEffect(() => {
    const h: ViewerHooks = {
      captureRegion: () => {
        if (!doc) return Promise.resolve(null);
        setRegionOn(true);
        return new Promise((resolve) => {
          regionResolve.current = resolve;
        });
      },
    };
    registerViewerHooks(h);
  }, [!!doc]);

  // ---------------------------------------------------------------- selection toolbar
  const onMouseUp = () => {
    if (regionOn) return;
    const info = readSelection(scroller.current, docKey);
    if (!info) {
      setSel(null);
      return;
    }
    const host = scroller.current!.getBoundingClientRect();
    const r = info.domRect;
    setSel({
      info,
      left: Math.min(Math.max(6, r.left - host.left + r.width / 2 - 165), Math.max(6, host.width - 340)),
      top: Math.max(6, r.top - host.top - 46 + scroller.current!.scrollTop) - (scroller.current!.scrollTop || 0),
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setSel(null);
      setRegionOn(false);
      setOpenAnn(null);
      if (regionResolve.current) {
        regionResolve.current(null);
        regionResolve.current = null;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---------------------------------------------------------------- scrolling / page tracking
  const onScroll = () => {
    const el = scroller.current;
    if (!el || !doc) return;
    scrollMemory.set(docKey, el.scrollTop);
    const page = visiblePageIndex(el);
    if (page >= 0 && page + 1 !== viewerState.currentPage) setViewerState({ currentPage: page + 1 });
  };

  function scrollToPage(page: number, smooth = true): void {
    const el = scroller.current;
    if (!el || !doc || viewerState.paperKey !== docKey) return;
    const target = el.querySelector<HTMLElement>(`[data-page="${page - 1}"]`);
    if (target) {
      el.scrollTo({ top: Math.max(0, target.offsetTop - 14), behavior: smooth ? "smooth" : "auto" });
      setViewerState({ currentPage: page });
      return;
    }
    // page not mounted yet: jump by the average page height, it renders on intersection
    const mounted = [...el.querySelectorAll<HTMLElement>("[data-page]")];
    const avg = mounted.length ? mounted.reduce((s, n) => s + n.offsetHeight + 18, 0) / mounted.length : 800;
    el.scrollTo({ top: (page - 1) * avg, behavior: smooth ? "smooth" : "auto" });
    setViewerState({ currentPage: page });
  }

  /** First open of a paper: use the whole pane width. */
  async function fitWidth(d: PDFDocumentProxy): Promise<void> {
    const el = scroller.current;
    if (!el) return;
    try {
      const p = await getPage(docKey, 0);
      const w = p.getViewport({ scale: 1 }).width;
      const next = Math.max(0.4, Math.min(3, (el.clientWidth - 34) / w));
      setScale(Math.round(next * 100) / 100);
    } catch {
      // keep the default scale when page 1 is unavailable
    }
  }

  function zoomBy(delta: number): void {
    const next = Math.min(3, Math.max(0.5, Math.round((scale + delta) * 100) / 100));
    setScale(next);
    localStorage.setItem("scholarpi.zoom", String(next));
  }

  const grouped = useMemo(() => {
    const m = new Map<number, Box[]>();
    for (const a of annotations) {
      const list = m.get(a.pageIndex) || [];
      list.push({ rects: a.rects || [], color: a.color, kind: a.type, ann: a });
      m.set(a.pageIndex, list);
    }
    return m;
  }, [annotations]);

  const onAnnotationClick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-ann]");
    if (!el) return;
    const ann = annotations.find((a) => a.key === el.dataset.ann);
    if (!ann) return;
    const host = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setOpenAnn({ ann, left: e.clientX - host.left + 12, top: e.clientY - host.top + 12 });
    e.stopPropagation();
  };

  return (
    <div class="viewer">
      <div class="viewer-bar">
        <span class="doc-title" title={item?.title || ""}>
          {item ? item.title : "未打开文献"}
        </span>
        <div class="spacer" />
        {doc && (
          <>
            <button class="icon-btn" title="缩小" onClick={() => zoomBy(-0.2)}>
              −
            </button>
            <span class="zoom">{Math.round(scale * 100)}%</span>
            <button class="icon-btn" title="放大" onClick={() => zoomBy(0.2)}>
              ＋
            </button>
            <span class="page-nav">
              <input
                type="number"
                min={1}
                max={doc.numPages}
                value={viewerState.currentPage}
                onChange={(e) => gotoPage(Number((e.target as HTMLInputElement).value) || 1)}
                title="跳转到页码"
              />
              <span class="muted small">/ {doc.numPages}</span>
            </span>
            <button class="icon-btn" title="适应宽度" onClick={() => { localStorage.removeItem("scholarpi.zoom"); if (doc) void fitWidth(doc); }}>
              ⤢
            </button>
            <button class="icon-btn" title="框图提问（拖出一个方框）" data-active={String(regionOn)} onClick={() => setRegionOn(!regionOn)}>
              ▣
            </button>
          </>
        )}
      </div>

      <div
        class="pages"
        ref={scroller}
        data-key={docKey}
        onScroll={onScroll}
        onMouseUp={onMouseUp}
        onClick={onAnnotationClick}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = (e.dataTransfer as DataTransfer)?.files?.[0];
          if (f && /\.pdf$/i.test(f.name)) onOpenFile?.(f);
        }}
      >
        {!doc && (
          <div class="viewer-empty">
            {error ? (
              <PdfError
                error={error}
                item={item}
                onRetry={() => {
                  setError("");
                  setAttempt((a) => a + 1);
                }}
              />
            ) : busy ? (
              <p>
                <span class="spinner" /> {loadLabel(busy, dl)}
              </p>
            ) : (
              <>
                <div class="empty-logo">π</div>
                <p>拖入 PDF，或从左侧文献栏打开一篇。</p>
                <p class="muted small">内置 3 篇演示论文，无需上传即可体验 AI 渐进式精读。</p>
              </>
            )}
          </div>
        )}
        {doc &&
          Array.from({ length: doc.numPages }, (_, i) => (
            <PageView
              key={`${docKey}-${i}`}
              docKey={docKey}
              index={i}
              scale={scale}
              root={scroller}
              boxes={grouped.get(i) || []}
              pulse={pulse && pulse.pageIndex === i ? pulse : null}
              regionOn={regionOn}
              onRegion={async (index, rect) => {
                setRegionOn(false);
                try {
                  const img = await renderActiveRegion(index, rect);
                  if (item) api.quick.startImage({ libraryID: item.libraryID, itemKey: item.itemKey }, img);
                  regionResolve.current?.(img);
                } catch (e: any) {
                  setError(String(e?.message || e));
                  regionResolve.current?.(null);
                }
                regionResolve.current = null;
              }}
              onRegionCancel={() => {
                setRegionOn(false);
                regionResolve.current?.(null);
                regionResolve.current = null;
              }}
            />
          ))}
      </div>

      {sel && item && <SelectionToolbar sel={sel} item={item} onClose={() => setSel(null)} />}
      {openAnn && (
        <div class="ann-pop" style={{ left: `${Math.max(8, openAnn.left)}px`, top: `${Math.max(8, openAnn.top)}px` }}>
          <div class="ann-head">
            <span class="swatch" style={{ background: openAnn.ann.color }} />
            <span>
              {openAnn.ann.type === "image" ? "图片批注" : openAnn.ann.type === "note" ? "便签" : "批注"} · p.{openAnn.ann.pageLabel}
            </span>
            <button class="chip" onClick={() => setOpenAnn(null)}>
              ×
            </button>
          </div>
          {openAnn.ann.imageData && <img class="ann-img" src={openAnn.ann.imageData} alt="" />}
          {openAnn.ann.text && <blockquote class="ann-quote">{openAnn.ann.text}</blockquote>}
          {openAnn.ann.comment && (
            <div class="md">
              <Markdown text={openAnn.ann.comment} />
            </div>
          )}
        </div>
      )}
      {regionOn && <div class="region-hint">拖动鼠标框选一张图 / 一个表格，松开即提问 · Esc 取消</div>}
    </div>
  );
}

function listAnnotationsFallback(item: Paper | null): Promise<Annotation[]> {
  return item ? listAnnotations(item).catch(() => [] as Annotation[]) : Promise.resolve([]);
}

/** Percentage when the size is known, transferred bytes when the server omits content-length. */
function loadLabel(busy: string, dl: { r: number; t: number } | null): string {
  if (busy === "parse") return "正在解析…";
  if (busy !== "download") return "";
  if (!dl) return "正在下载 PDF…";
  if (!dl.t) return `正在下载 PDF（${Math.round(dl.r / 1024)} KB）…`;
  return `正在下载 PDF（${Math.min(99, Math.round((dl.r / dl.t) * 100))}%）…`;
}

// ---------------------------------------------------------------------------
// one page: canvas + invisible selectable text layer + annotation overlay

interface PageViewProps {
  docKey: string;
  index: number;
  scale: number;
  root: { current?: HTMLDivElement | null };
  boxes: Box[];
  pulse: { rects: number[][] } | null;
  regionOn: boolean;
  onRegion: (pageIndex: number, rect: number[]) => void;
  onRegionCancel: () => void;
}

function PageView({ docKey, index, scale, root, boxes, pulse, regionOn, onRegion, onRegionCancel }: PageViewProps) {
  const holder = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState<PageViewport | null>(null);
  const [visible, setVisible] = useState(index < 2);

  useEffect(() => {
    if (visible) return;
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setVisible(true), {
      root: root.current || null,
      rootMargin: "900px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [visible, root]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: any = null;
    (async () => {
      let page: PDFPageProxy;
      try {
        page = await getPage(docKey, index);
      } catch (e) {
        if (!cancelled) console.warn("[ScholarPi] page unavailable", index, e);
        return;
      }
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      setVp(viewport);
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d", { alpha: false });
      if (!canvas || !ctx) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const hi = page.getViewport({ scale: scale * dpr });
      void buildTextLayer(docKey, index, textRef.current, page, viewport);
      task = page.render({ canvas, canvasContext: ctx, viewport: hi } as any);
      try {
        await task.promise;
      } catch {
        // cancelled render: the next effect pass owns the canvas
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel?.();
    };
  }, [visible, docKey, index, scale]);

  const w = vp?.width || 620;
  const h = vp?.height || 800;
  return (
    <div class="page" data-page={index} ref={holder} style={{ width: `${w}px`, height: `${h}px` }}>
      <canvas ref={canvasRef} class="page-canvas" />
      <div class="pdf-text" ref={textRef} style={{ width: `${w}px`, height: `${h}px` }} />
      {vp && (
        <div class="overlay">
          {boxes.map((b, i) => (
            <OverlayBox key={`${i}-${b.ann?.key || ""}`} vp={vp} rects={b.rects} kind={b.kind} color={b.color} ann={b.ann} />
          ))}
          {pulse && <OverlayBox key="pulse" vp={vp} rects={pulse.rects} kind="agent" color="#6d5bd0" />}
        </div>
      )}
      {vp && regionOn && <RegionCapture index={index} vp={vp} onRegion={onRegion} onCancel={onRegionCancel} />}
      {!vp && <div class="page-ph">第 {index + 1} 页</div>}
    </div>
  );
}

function OverlayBox({
  vp,
  rects,
  kind,
  color,
  ann,
}: {
  vp: PageViewport;
  rects: number[][];
  kind: Box["kind"];
  color: string;
  ann?: Annotation;
}) {
  return (
    <>
      {rects.map((rect, i) => {
        const [x1, y1, x2, y2] = vp.convertToViewportRectangle(rect);
        const style: any = {
          left: `${Math.min(x1, x2)}px`,
          top: `${Math.min(y1, y2)}px`,
          width: `${Math.abs(x2 - x1)}px`,
          height: `${Math.abs(y2 - y1)}px`,
          "--ann": color || "#ffd400",
        };
        return (
          <div
            key={i}
            class={`ov ov-${kind}${ann ? " has-ann" : ""}`}
            style={style}
            data-ann={i === 0 ? ann?.key : undefined}
            title={i === 0 && ann ? (ann.comment || ann.text).slice(0, 160) : undefined}
          >
            {kind === "note" ? <span class="note-dot">✎</span> : null}
            {kind === "image" && ann?.imageData ? <img src={ann.imageData} alt="" /> : null}
          </div>
        );
      })}
    </>
  );
}

/** pdf.js text runs → absolutely positioned transparent spans that also carry char indices. */
async function buildTextLayer(docKey: string, index: number, host: HTMLDivElement | null, page: PDFPageProxy, viewport: PageViewport): Promise<void> {
  if (!host) return;
  host.textContent = "";
  let spans;
  try {
    const data = await getPageData(docKey, index);
    pageInfos.set(infoKey(docKey, index), { chars: data.chars, viewBox: data.viewBox, viewport });
    spans = data.spans;
  } catch (e: any) {
    console.warn("[ScholarPi] 文本层构建失败", e);
    const tc = await page.getTextContent();
    spans = (tc.items as any[]).map((it) => ({
      text: String(it.str || ""),
      rect: [it.transform[4], it.transform[5], it.transform[4] + (Number(it.width) || 0), it.transform[5] + (Number(it.height) || 10)],
      start: -1,
      end: -1,
    }));
    pageInfos.set(infoKey(docKey, index), { chars: [], viewBox: [0, 0, viewport.width, viewport.height], viewport });
  }
  const els: HTMLElement[] = [];
  for (const s of spans) {
    if (!s.text.trim()) continue;
    const r = viewport.convertToViewportRectangle(s.rect);
    const el = document.createElement("span");
    el.className = "tl-run";
    el.dataset.start = String(s.start);
    el.dataset.end = String(s.end);
    el.dataset.w = String(Math.abs(r[2] - r[0]));
    el.style.left = `${Math.min(r[0], r[2])}px`;
    el.style.top = `${Math.min(r[1], r[3])}px`;
    el.style.height = `${Math.max(4, Math.abs(r[3] - r[1]))}px`;
    el.style.fontSize = `${Math.max(4, Math.abs(r[3] - r[1]) * 0.82)}px`;
    el.textContent = s.text;
    host.appendChild(el);
    els.push(el);
  }
  // stretch each run onto its PDF box so the selection geometry follows the ink
  requestAnimationFrame(() => {
    for (const el of els) {
      const target = Number(el.dataset.w || 0);
      const natural = el.offsetWidth;
      if (target > 2 && natural > 2) el.style.transform = `scaleX(${(target / natural).toFixed(4)})`;
    }
  });
}

function RegionCapture({ index, vp, onRegion, onCancel }: { index: number; vp: PageViewport; onRegion: (i: number, r: number[]) => void; onCancel: () => void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const draw = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const el = boxRef.current;
    if (!el) return;
    el.style.left = `${Math.min(a.x, b.x)}px`;
    el.style.top = `${Math.min(a.y, b.y)}px`;
    el.style.width = `${Math.abs(b.x - a.x)}px`;
    el.style.height = `${Math.abs(b.y - a.y)}px`;
  };
  const at = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  return (
    <div
      class="region-capture"
      onMouseDown={(e) => {
        startRef.current = at(e);
        draw(startRef.current, startRef.current);
      }}
      onMouseMove={(e) => startRef.current && draw(startRef.current, at(e))}
      onMouseUp={(e) => {
        const a = startRef.current;
        startRef.current = null;
        if (!a) return;
        const b = at(e);
        if (Math.abs(a.x - b.x) < 14 || Math.abs(a.y - b.y) < 14) {
          onCancel();
          return;
        }
        const p1 = vp.convertToPdfPoint(a.x, a.y);
        const p2 = vp.convertToPdfPoint(b.x, b.y);
        onRegion(index, [
          Math.min(p1[0], p2[0]),
          Math.min(p1[1], p2[1]),
          Math.max(p1[0], p2[0]),
          Math.max(p1[1], p2[1]),
        ]);
      }}
    >
      <div class="region-box" ref={boxRef} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// selection → char range → toolbar

interface SelInfo {
  text: string;
  pageIndex: number;
  rects: number[][];
  viewBox: number[];
  pageLabel: string;
  domRect: DOMRect;
}

/** Map a browser selection over the invisible text layer back to PDF rects. */
function readSelection(host: HTMLElement | null, docKey: string): SelInfo | null {
  if (!host || !docKey) return null;
  const s = document.getSelection();
  if (!s || s.isCollapsed || !s.rangeCount) return null;
  const range = s.getRangeAt(0);
  if (!host.contains(range.commonAncestorContainer)) return null;
  const text = s.toString().replace(/\s+/g, " ").trim();
  if (text.length < 2) return null;
  const pageEl = (range.startContainer.parentElement || host).closest<HTMLElement>("[data-page]");
  if (!pageEl || !host.contains(pageEl)) return null;
  const startRun = runOf(range.startContainer);
  const endRun = runOf(range.endContainer);
  if (!startRun || !endRun) return null;
  const pageIndex = Number(pageEl.dataset.page || 0);
  const info = pageInfos.get(infoKey(docKey, pageIndex));
  if (!info) return null;
  let start = Number(startRun.dataset.start);
  let end = Number(endRun.dataset.end);
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end)) return null;
  if (range.startContainer.nodeType === Node.TEXT_NODE) start += cpBefore(range.startContainer.textContent || "", range.startOffset);
  if (range.endContainer.nodeType === Node.TEXT_NODE) {
    const off = cpBefore(range.endContainer.textContent || "", range.endOffset);
    if (off > 0) end = Number(endRun.dataset.start) + off - 1;
  }
  if (end < start) end = start;
  end = Math.min(end, info.chars.length - 1);
  let rects: number[][] = [];
  try {
    rects = getRangeRects(info.chars, start, end);
  } catch {
    rects = [];
  }
  if (!rects.length) return null;
  return { text, pageIndex, rects, viewBox: info.viewBox, pageLabel: String(pageIndex + 1), domRect: range.getBoundingClientRect() };
}

function runOf(node: Node | null): HTMLElement | null {
  let el: Node | null = node;
  while (el && !(el instanceof HTMLElement)) el = el.parentNode;
  return (el?.closest?.(".tl-run") as HTMLElement | undefined) || null;
}

/** Code points (not UTF-16 units) before `offset`, so indices line up with reader.ts. */
function cpBefore(text: string, offset: number): number {
  return Array.from(text.slice(0, Math.max(0, Math.min(offset, text.length)))).length;
}

function SelectionToolbar({ sel, item, onClose }: { sel: { info: SelInfo; left: number; top: number }; item: Paper; onClose: () => void }) {
  const info = sel.info;
  const selection = { text: info.text, pageIndex: info.pageIndex, rects: info.rects, viewBox: info.viewBox, pageLabel: info.pageLabel };
  const ref = { libraryID: item.libraryID, itemKey: item.itemKey };
  const actions = getSettings().quickActions;

  return (
    <div class="sel-bar" style={{ left: `${sel.left}px`, top: `${sel.top}px` }} onMouseDown={(e) => e.preventDefault()}>
      <button class="chip" onClick={() => void api.quick.start({ id: "ask", label: "问 AI", mode: "ask", prompt: "" } as any, ref, selection)}>
        问 AI
      </button>
      {actions.map((a) => (
        <button class="chip" title={a.mode === "translate" ? "快速翻译" : "在右侧会话中提问"} onClick={() => void api.quick.start(a, ref, selection)}>
          {a.label}
        </button>
      ))}
      <button
        class="chip"
        title="把选中文本作为引文插入右侧输入框"
        onClick={() => {
          globalEvents.emit({ type: "insert-quote", text: info.text, pageLabel: info.pageLabel });
          onClose();
        }}
      >
        加入对话
      </button>
      <button
        class="chip"
        title="保存为高亮批注"
        onClick={() => {
          void saveSelectionAsHighlight(item, selection, "").catch((e) => console.warn("[ScholarPi] 保存高亮失败", e));
          onClose();
        }}
      >
        🖍
      </button>
      <button class="chip close" onClick={onClose}>
        ×
      </button>
    </div>
  );
}

/** Index of the page nearest the top third of the visible area. */
function visiblePageIndex(el: HTMLElement): number {
  const pages = [...el.querySelectorAll<HTMLElement>("[data-page]")];
  if (!pages.length) return -1;
  const line = el.scrollTop + el.clientHeight * 0.3;
  let best = pages[0];
  for (const p of pages) {
    if (p.offsetTop <= line) best = p;
    else break;
  }
  return Number(best.dataset.page || 0);
}

/**
 * A PDF that would not open, said by kind: the retry is real, the original link is
 * never more than one click away, and nothing on the page has been thrown away.
 */
function PdfError({ error, item, onRetry }: { error: string; item: Paper | null; onRetry: () => void }) {
  const err = classifyError(error);
  const href = safeUrl(item?.pdfUrl) || safeUrl(item?.url);
  return (
    <div class="error-box">
      <div>{err.message}</div>
      <div class="err-actions">
        <button class="primary" onClick={onRetry}>
          点击重试
        </button>
        {err.actions.includes("example") && (
          <button class="chip" onClick={() => void getApi().openPaper(EXAMPLE_ITEM_KEY)}>
            查看示例
          </button>
        )}
        {!!href && (
          <a class="chip" href={href} target="_blank" rel="noopener noreferrer">
            打开原文链接
          </a>
        )}
      </div>
      <p class="muted small">也可以把 PDF 直接拖进来，或在左侧重新点开这篇论文；批注与已有的精读报告都还在。</p>
      {!!err.detail && <p class="muted small">技术信息：{err.detail.slice(0, 160)}</p>}
    </div>
  );
}
