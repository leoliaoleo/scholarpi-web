/**
 * The knowledge-base half of the left rail: global search, research collections, tags,
 * batch import (PDF / arXiv / DOI), JSON + BibTeX backup, the metadata card editor and the
 * multi-select that feeds 多篇横向对比矩阵.
 *
 * It only reads and writes `core/library.ts`; opening a paper still goes through the
 * callback the workbench passes in, so the reader, 划词 and 框图 are untouched.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Collection, ImportResult, KbSearchResult, PaperCard } from "../core/library";
import { getItem, paperTitle, type Paper } from "../core/paper";
import { clearSelection, selectedKeys, selectionChanges, toggleSelection } from "../core/selection";
import { getApi, subscribe } from "./api";

const api = getApi();

interface Filter {
  collection: string;
  tag: string;
  text: string;
}

const EMPTY: Filter = { collection: "", tag: "", text: "" };

/**
 * 逐篇入库进度：core/library.ts 每写完一条就发一个事件，所以左边这条横幅不管是面板点的
 * 还是 agent 的 kb_import 触发的都长得一样。最后一篇之后再亮 4 秒就收起来。
 */
function useImportProgress() {
  const [job, setJob] = useState<{ done: number; total: number; title: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () =>
      subscribe(api.events, (e: any) => {
        if (e.type !== "kb-import-progress") return;
        setJob({ done: Number(e.done) || 0, total: Number(e.total) || 0, title: String(e.title || "") });
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setJob(null), 4000);
      }),
    [],
  );
  useEffect(() => () => clearTimeout(timer.current), []);
  return job;
}

export function LibraryRail({
  papers,
  openKey,
  onOpen,
  onRemove,
  onChanged,
}: {
  papers: Paper[];
  openKey: string;
  onOpen: (item: Paper) => void;
  onRemove: (item: Paper) => void;
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState<Filter>(EMPTY);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  const [cardKey, setCardKey] = useState<string | null>(null);
  const [sel, setSel] = useState<string[]>(() => selectedKeys());
  const [panel, setPanel] = useState<"" | "import" | "backup">("");
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const progress = useImportProgress();

  const reload = useCallback(async () => {
    const [cols, tagRows] = await Promise.all([api.kb.collections(), api.kb.tags()]);
    setCollections(cols);
    setTags(tagRows);
  }, []);

  useEffect(() => {
    void reload();
    void api.kb.ensureSeeded().then(reload).catch(() => undefined);
  }, [reload, tick]);

  useEffect(() => subscribe(selectionChanges, (keys: string[]) => setSel([...keys])), []);
  useEffect(() => {
    const off = subscribe(api.events, (e: any) => {
      if (e.type === "library-changed" || e.type === "cards-changed") {
        void reload();
        setTick((t) => t + 1);
      }
    });
    return off;
  }, [reload]);

  const visible = useMemo(() => {
    const inCol = filter.collection ? new Set(collections.find((c) => c.id === filter.collection)?.itemKeys || []) : null;
    const q = filter.text.trim().toLowerCase();
    return papers.filter((p) => {
      if (inCol && !inCol.has(p.itemKey)) return false;
      if (filter.tag && !(p.tags || "").toLowerCase().includes(filter.tag.toLowerCase())) return false;
      if (q) {
        const hay = `${p.title} ${p.authors} ${p.year} ${p.venue} ${p.abstract}`.toLowerCase();
        if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
      }
      return true;
    });
  }, [papers, filter, collections]);

  const mine = visible.filter((p) => p.source !== "demo");
  const demo = visible.filter((p) => p.source === "demo");
  const filtering = filter.collection || filter.tag || filter.text;

  return (
    <div class="kb">
      <KbSearch onOpen={onOpen} />

      <CollectionsBar collections={collections} active={filter.collection} onPick={(id) => setFilter({ ...filter, collection: id })} onChanged={reload} />

      <div class="kb-tools">
        <button class="chip" data-on={panel === "import"} onClick={() => setPanel(panel === "import" ? "" : "import")}>
          ⇪ 批量导入
        </button>
        <button class="chip" data-on={panel === "backup"} onClick={() => setPanel(panel === "backup" ? "" : "backup")}>
          💾 备份
        </button>
        {!!filtering && (
          <button class="chip" onClick={() => setFilter(EMPTY)}>
            ✕ 清除筛选
          </button>
        )}
      </div>
      {progress && panel !== "import" && (
        <div class="kb-progress" role="status">
          <span class="kb-progress-track">
            <i style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} />
          </span>
          <span class="small">
            已入库 {progress.done}/{progress.total} · {progress.title}
          </span>
        </div>
      )}
      {panel === "import" && <ImportPanel collections={collections} progress={progress} onChanged={onChanged} onDone={reload} onError={setError} />}
      {panel === "backup" && <BackupPanel onChanged={onChanged} onError={setError} />}
      {error && <div class="error-box">{error}</div>}

      {sel.length > 0 && (
        <div class="kb-select-bar">
          <span class="small">已选 {sel.length} 篇</span>
          <button
            class="chip primary"
            disabled={sel.length < 2}
            title={sel.length < 2 ? "再勾选 1 篇（最多 5 篇）" : "在右侧会话中生成对比矩阵"}
            onClick={() => api.events.emit({ type: "run-skill", skill: "matrix" })}
          >
            📊 对比矩阵
          </button>
          <CollectionsPicker
            collections={collections}
            onPick={async (id) => {
              for (const k of sel) await api.kb.addToCollection(id, k);
              await reload();
              onChanged();
            }}
          />
          <button class="chip" onClick={() => clearSelection()}>
            清除
          </button>
        </div>
      )}

      <TagBar tags={tags} active={filter.tag} onPick={(t) => setFilter({ ...filter, tag: filter.tag === t ? "" : t })} />

      <PaperSection
        title="我的文献"
        items={mine}
        openKey={openKey}
        collections={collections}
        onOpen={onOpen}
        onRemove={onRemove}
        onCard={setCardKey}
        empty={filtering ? "没有符合筛选条件的文献" : "上传 PDF，或在上方粘贴 arXiv ID / DOI 批量导入"}
      />
      <PaperSection
        title="演示论文"
        items={demo}
        openKey={openKey}
        collections={collections}
        onOpen={onOpen}
        onCard={setCardKey}
        empty={demo.length ? (filtering ? "演示论文不在此筛选范围内" : "") : "未取到内置论文：请确认已运行 npm run build（论文随静态包 /papers 发布）"}
      />

      {cardKey && <CardEditor itemKey={cardKey} onClose={() => setCardKey(null)} onChanged={onChanged} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// global search

function KbSearch({ onOpen }: { onOpen: (item: Paper) => void }) {
  const [text, setText] = useState("");
  const [semantic, setSemantic] = useState(true);
  const [fullText, setFullText] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<KbSearchResult | null>(null);
  const [error, setError] = useState("");

  const run = async () => {
    if (!text.trim()) {
      setResult(null);
      return;
    }
    setBusy(true);
    setError("");
    try {
      setResult(await api.kb.search({ query: text.trim(), semantic, fullText, limit: 20 }));
    } catch (e: any) {
      setError(String(e?.message || e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="kb-search">
      <form
        class="url-add"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input value={text} placeholder="知识库检索：关键词或中文提问" onInput={(e) => setText((e.target as HTMLInputElement).value)} />
        <button class="icon-btn" type="submit" title="检索" disabled={busy}>
          {busy ? <span class="spinner" /> : "🔎"}
        </button>
      </form>
      <div class="kb-switch">
        <label title="让模型先扩展中英同义词，召回更高、多一次调用">
          <input type="checkbox" checked={semantic} onChange={(e) => setSemantic((e.target as HTMLInputElement).checked)} /> 语义扩展
        </label>
        <label title="把已解析的 PDF 全文也纳入打分">
          <input type="checkbox" checked={fullText} onChange={(e) => setFullText((e.target as HTMLInputElement).checked)} /> 含全文
        </label>
        {result && <span class="muted small">{`${result.total} 条命中 · ${result.engine}`}</span>}
      </div>
      {error && <div class="error-box">{error}</div>}
      {result?.expanded && <div class="kb-expand" title="模型为本次检索扩展的检索词">扩展词：{result.expanded}</div>}
      {!!result?.hits.length && (
        <div class="kb-hits">
          {result.hits.map((h) => (
            <button class="kb-hit" onClick={() => {
              const item = api.papers.get(h.itemKey);
              if (item) onOpen(item);
            }}>
              <span class="p-title">{h.title}</span>
              <span class="p-meta muted">
                {[h.authors.split(",").slice(0, 2).join(","), h.year, h.venue].filter(Boolean).join(" · ")}
                {h.citations ? ` · 被引 ${h.citations}` : ""}
                {h.pdf ? "" : " · 无PDF"}
              </span>
              <span class="kb-snip">{h.snippet}</span>
              <span class="kb-hit-tags">
                {h.fields.slice(0, 3).map((f) => (
                  <em class="tag mini">{f}</em>
                ))}
                {h.tags.slice(0, 3).map((t) => (
                  <em class="tag mini">{t}</em>
                ))}
                {!h.hasCard && <em class="tag mini warn">无卡片</em>}
              </span>
            </button>
          ))}
        </div>
      )}
      {result && !result.hits.length && <div class="group-empty">没有命中的文献。换个说法，或勾选「含全文」再试。</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// collections

function CollectionsBar({ collections, active, onPick, onChanged }: { collections: Collection[]; active: string; onPick: (id: string) => void; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");

  const add = async () => {
    const label = name.trim();
    setAdding(false);
    setName("");
    if (!label) return;
    const row = await api.kb.createCollection(label);
    onPick(row.id);
    onChanged();
  };

  return (
    <div class="kb-collections">
      <div class="group-title">
        研究专题<span class="muted">{collections.length}</span>
        <button class="link-btn" onClick={() => setAdding(!adding)} title="新建专题">
          ＋
        </button>
      </div>
      {adding && (
        <form
          class="url-add"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input autoFocus value={name} placeholder="专题名称，如「高效微调」" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          <button class="icon-btn" type="submit" title="创建">
            ✓
          </button>
        </form>
      )}
      <div class="chips">
        <button class={active ? "chip" : "chip on"} onClick={() => onPick("")}>
          全部
        </button>
        {collections.map((c) => (
          <span class="chip-wrap" key={c.id}>
            <button class={active === c.id ? "chip on" : "chip"} title={c.description || c.name} onClick={() => onPick(active === c.id ? "" : c.id)} style={c.color ? { borderColor: c.color } : undefined}>
              {c.name}
              <b>{c.itemKeys.length}</b>
            </button>
            <span
              class="chip-del"
              title="删除专题（不影响文献）"
              onClick={async () => {
                if (!window.confirm(`删除专题「${c.name}」？文献本身会保留。`)) return;
                await api.kb.deleteCollection(c.id);
                if (active === c.id) onPick("");
                onChanged();
              }}
            >
              ×
            </span>
          </span>
        ))}
        {!collections.length && <span class="muted small">还没有专题：点 ＋ 建一个研究方向。</span>}
      </div>
    </div>
  );
}

/** 把选中的文献放进某个专题（专题列表来自 CollectionsBar）。 */
function CollectionsPicker({ collections, onPick }: { collections: Collection[]; onPick: (id: string) => void }) {
  const [done, setDone] = useState("");
  if (!collections.length) return null;
  return (
    <select
      class="chip-select"
      value=""
      onChange={async (e) => {
        const id = (e.target as HTMLSelectElement).value;
        if (!id) return;
        await onPick(id);
        setDone(collections.find((c) => c.id === id)?.name || "");
        setTimeout(() => setDone(""), 2500);
        (e.target as HTMLSelectElement).value = "";
      }}
      title="把选中的文献加入专题"
    >
      <option value="">{done ? `已加入 ${done}` : "加入专题…"}</option>
      {collections.map((c) => (
        <option value={c.id}>{c.name}</option>
      ))}
    </select>
  );
}

function TagBar({ tags, active, onPick }: { tags: { tag: string; count: number }[]; active: string; onPick: (t: string) => void }) {
  if (!tags.length) return null;
  return (
    <div class="chips tags">
      {tags.slice(0, 14).map((t) => (
        <button class={active === t.tag ? "chip on" : "chip"} onClick={() => onPick(t.tag)} title={`标签筛选：${t.tag}`}>
          #{t.tag}
          <b>{t.count}</b>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// the list itself

function PaperSection({
  title,
  items,
  openKey,
  collections,
  onOpen,
  onRemove,
  onCard,
  empty,
}: {
  title: string;
  items: Paper[];
  openKey: string;
  collections: Collection[];
  onOpen: (item: Paper) => void;
  onRemove?: (item: Paper) => void;
  onCard: (itemKey: string) => void;
  empty?: string;
}) {
  const [tick, setTick] = useState(0);
  const sel = useSelection();
  const cards = useCardKeys(tick);

  useEffect(() => {
    const off = subscribe(api.events, (e: any) => {
      if (e.type === "cards-changed" || e.type === "library-changed") setTick((t) => t + 1);
    });
    return off;
  }, []);

  return (
    <div class="group">
      <div class="group-title">
        {title}
        <span class="muted">{items.length}</span>
      </div>
      {items.map((p) => {
        const active = openKey.endsWith(`/${p.itemKey}`);
        const cols = collections.filter((c) => (c.itemKeys || []).includes(p.itemKey));
        const tagList = String(p.tags || "")
          .split(/[,;，、]/)
          .map((s) => s.trim())
          .filter((s) => s && !["演示论文", "本地上传", "链接添加", "arXiv", "DOI", "文献库"].includes(s));
        return (
          <div class={active ? "paper-row active" : "paper-row"} key={p.itemKey}>
            <input
              class="p-check"
              type="checkbox"
              checked={sel.includes(p.itemKey)}
              title="勾选后可生成对比矩阵 / 批量加入专题"
              onChange={() => toggleSelection(p.itemKey)}
            />
            <button class="paper" onClick={() => onOpen(p)} title={p.title}>
              <span class="p-title">{paperTitle(p)}</span>
              {p.authors && <span class="p-meta">{p.authors.split(",").slice(0, 2).join(", ")}{p.authors.split(",").length > 2 ? " 等" : ""}</span>}
              <span class="p-meta muted">
                {[p.year, p.venue, p.totalPages ? `${p.totalPages} 页` : ""].filter(Boolean).join(" · ")}
                {p.source === "url" && !p.pdfUrl ? " · 仅链接" : ""}
              </span>
              {(cols.length || tagList.length || cards.has(p.itemKey)) && (
                <span class="p-badges">
                  {cols.map((c) => (
                    <em class="tag mini" style={{ background: `${c.color}22`, borderColor: `${c.color}66` }} key={c.id}>
                      {c.name}
                    </em>
                  ))}
                  {tagList.slice(0, 3).map((t) => (
                    <em class="tag mini" key={t}>
                      {t}
                    </em>
                  ))}
                  {cards.has(p.itemKey) ? <em class="tag mini ok" title="已有元数据卡片">📋</em> : <em class="tag mini warn" title="尚无元数据卡片">📋＋</em>}
                </span>
              )}
            </button>
            <span class="p-acts">
              <span class="p-act" title="元数据卡片" onClick={() => onCard(p.itemKey)}>
                📋
              </span>
              {onRemove && (
                <span
                  class="p-act del"
                  title="从文献库移除"
                  onClick={() => onRemove(p)}
                >
                  ×
                </span>
              )}
            </span>
          </div>
        );
      })}
      {!items.length && empty && <div class="group-empty">{empty}</div>}
    </div>
  );
}

function useSelection(): string[] {
  const [sel, setSel] = useState<string[]>(() => selectedKeys());
  useEffect(() => subscribe(selectionChanges, (keys: string[]) => setSel([...keys])), []);
  return sel;
}

/** Which papers already have a card with real analysis fields (for the 📋 badge). */
function useCardKeys(tick: number): Set<string> {
  const [keys, setKeys] = useState<Set<string>>(new Set());
  useEffect(() => {
    let dead = false;
    void api.kb
      .cards()
      .then((cards) => {
        if (!dead) setKeys(new Set(cards.filter((c) => c.method || c.summary || c.metrics).map((c) => c.itemKey)));
      })
      .catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [tick]);
  return keys;
}

// ---------------------------------------------------------------------------
// import

function ImportPanel({
  collections,
  progress,
  onChanged,
  onDone,
  onError,
}: {
  collections: Collection[];
  progress: { done: number; total: number; title: string } | null;
  onChanged: () => void;
  onDone: () => void;
  onError: (e: string) => void;
}) {
  const [text, setText] = useState("");
  const [collection, setCollection] = useState("");
  const [withCard, setWithCard] = useState(true);
  const [busy, setBusy] = useState("");
  const [rows, setRows] = useState<ImportResult[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = async () => {
    const ids = text.trim();
    if (!ids) return;
    setBusy("正在抓取元数据并入库…");
    onError("");
    setRows([]);
    try {
      const out = await api.kb.importBlock(ids, {
        collectionId: collection || undefined,
        withCard,
        onOne: (r) => setRows((prev) => [...prev, r]),
      });
      setRows(out);
      setText("");
      onChanged();
      onDone();
    } catch (e: any) {
      onError(String(e?.message || e));
    } finally {
      setBusy("");
    }
  };

  const addFiles = async (list: FileList | null) => {
    const files = Array.from(list || []).filter((f) => /\.pdf$/i.test(f.name));
    if (!files.length) return;
    setBusy(`正在解析 ${files.length} 个 PDF…`);
    onError("");
    setRows([]);
    try {
      setRows(await api.kb.importFiles(files, { collectionId: collection || undefined, withCard }));
      onChanged();
      onDone();
    } catch (e: any) {
      onError(String(e?.message || e));
    } finally {
      setBusy("");
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div class="kb-import">
      <textarea rows={3} value={text} placeholder="每行一个：1706.03762 / DOI / PDF 或 abs 链接" onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
      <div class="kb-import-row">
        <select value={collection} onChange={(e) => setCollection((e.target as HTMLSelectElement).value)} title="导入后归入专题">
          <option value="">不归入专题</option>
          {collections.map((c) => (
            <option value={c.id}>{c.name}</option>
          ))}
        </select>
        <label class="small" title="每篇发起一次模型调用">
          <input type="checkbox" checked={withCard} onChange={(e) => setWithCard((e.target as HTMLInputElement).checked)} /> 生成卡片
        </label>
        <button class="primary" onClick={() => void run()} disabled={!!busy}>
          抓取导入
        </button>
      </div>
      <div class="kb-import-row">
        <button onClick={() => fileRef.current?.click()}>批量上传 PDF</button>
        <input ref={fileRef} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => void addFiles((e.target as HTMLInputElement).files)} />
        <span class="muted small">PDF 只存本机 IndexedDB</span>
      </div>
      {busy && (
        <div class="busy">
          <span class="spinner" /> {busy}
          {progress && (
            <span class="muted">
              已入库 {progress.done}/{progress.total}
            </span>
          )}
        </div>
      )}
      {!!rows.length && (
        <div class="kb-import-log">
          {rows.map((r, i) => (
            <div class={r.ok ? "line ok" : "line err"} key={`${r.input}-${i}`}>
              <b>{r.ok ? (r.action === "existing" ? "已有" : "✓") : "✕"}</b>
              <span>{r.ok ? r.title || r.input : `${r.input}：${r.note}`}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// backup

function BackupPanel({ onChanged, onError }: { onChanged: () => void; onError: (e: string) => void }) {
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const save = async (kind: "json" | "bib") => {
    setBusy(true);
    try {
      const text = kind === "json" ? await api.kb.exportJson() : await api.kb.exportBibtex();
      api.kb.download(kind === "json" ? `scholarpi-kb-${stamp()}.json` : `scholarpi-${stamp()}.bib`, text, kind === "json" ? "application/json" : "application/x-bibtex");
    } catch (e: any) {
      onError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const load = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    onError("");
    try {
      const replace = window.confirm("确定要「替换」当前知识库吗？\n\n「确定」＝先清空专题/卡片/批注/自建文献再导入（导入前建议先导出备份）。\n「取消」＝与现有内容合并导入。");
      const summary = await api.kb.importBackup(await file.text(), replace ? "replace" : "merge");
      await api.papers.reload();
      onChanged();
      window.alert(
        `导入完成：文献 ${summary.papers}｜专题 ${summary.collections}｜卡片 ${summary.cards}｜批注 ${summary.annotations}` +
          (summary.skipped.length ? `\n跳过 ${summary.skipped.length} 条：\n${summary.skipped.slice(0, 8).join("\n")}` : ""),
      );
    } catch (e: any) {
      onError(String(e?.message || e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div class="kb-import">
      <div class="kb-import-row">
        <button onClick={() => void save("json")} disabled={busy}>
          导出 JSON
        </button>
        <button onClick={() => void save("bib")} disabled={busy}>
          导出 BibTeX
        </button>
        <button onClick={() => fileRef.current?.click()} disabled={busy}>
          导入 JSON
        </button>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => void load((e.target as HTMLInputElement).files?.[0])} />
      </div>
      <div class="muted small">
        JSON 备份含文献条目、专题、卡片与批注，不含 PDF 二进制；BibTeX 只含引用字段，可直接进 LaTeX 或 Zotero。
      </div>
    </div>
  );
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// metadata card editor

function CardEditor({ itemKey, onClose, onChanged }: { itemKey: string; onClose: () => void; onChanged: () => void }) {
  const [card, setCard] = useState<PaperCard | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [tags, setTags] = useState<string[]>([]);

  useEffect(() => {
    let dead = false;
    setLoaded(false);
    void (async () => {
      const [c, t] = await Promise.all([api.kb.card(itemKey), api.kb.paperTags(itemKey)]);
      if (dead) return;
      setCard(c);
      setTags(t);
      setLoaded(true);
    })();
    return () => {
      dead = true;
    };
  }, [itemKey]);

  if (!loaded) {
    return (
      <div class="kb-card-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div class="kb-card">
          <div class="busy">
            <span class="spinner" /> 读取卡片…
          </div>
        </div>
      </div>
    );
  }

  if (!card) {
    return (
      <div class="kb-card-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div class="kb-card">
          <div class="kb-card-head">
            <b>这篇文献已不在库中</b>
            <button class="icon-btn" onClick={onClose} title="关闭">
              ×
            </button>
          </div>
        </div>
      </div>
    );
  }

  const set = (patch: Partial<PaperCard>) => setCard({ ...card, ...patch });

  const save = async () => {
    setBusy("保存…");
    try {
      await api.kb.saveCard({ ...card, tags: tags.join(", ") });
      await api.kb.setTags(itemKey, tags);
      onChanged();
      setBusy("已保存");
      setTimeout(() => setBusy(""), 1800);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  };

  const generate = async () => {
    setBusy("模型正在读这篇论文…");
    setError("");
    try {
      const next = await api.kb.generateCard(itemKey, { fullText: true });
      setCard(next);
      setTags(await api.kb.paperTags(itemKey));
      onChanged();
    } catch (e: any) {
      setError(`${String(e?.message || e)}（未配置 Key 时无法生成，可手动填写）`);
    } finally {
      setBusy("");
    }
  };

  const remove = async () => {
    const item = getItem(itemKey);
    if (!item || !window.confirm(`从文献库移除《${paperTitle(item).slice(0, 30)}》？批注会保留在浏览器中。`)) return;
    await api.kb.remove(itemKey);
    onChanged();
    onClose();
  };

  return (
    <div class="kb-card-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class="kb-card">
        <div class="kb-card-head">
          <b title={card.title}>{card.title}</b>
          <button class="icon-btn" onClick={onClose} title="关闭">
            ×
          </button>
        </div>
        <div class="kb-card-meta">
          {[card.authors, card.year, card.venue, card.DOI].filter(Boolean).join(" · ") || "元数据待补充"}
          {card.citations ? ` · 被引 ${card.citations}` : ""}
          {card.basis ? ` · 来源：${basisLabel(card.basis)}` : ""}
        </div>
        <div class="kb-fields">
          <Field label="一句话总结" value={card.summary} onInput={(v) => set({ summary: v })} rows={2} />
          <Field label="核心方法" value={card.method} onInput={(v) => set({ method: v })} rows={3} />
          <Field label="数据集" value={card.datasets} onInput={(v) => set({ datasets: v })} rows={2} />
          <Field label="关键指标" value={card.metrics} onInput={(v) => set({ metrics: v })} rows={2} />
          <Field label="关键词" value={card.keywords} onInput={(v) => set({ keywords: v })} rows={2} hint="检索时权重较高" />
          <div class="field">
            <span class="label">标签</span>
            <div class="control">
              <input value={tags.join(", ")} onInput={(e) => setTags((e.target as HTMLInputElement).value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean))} />
              <div class="hint">标签存于卡片，演示论文也能加标签而不改动其本体。</div>
            </div>
          </div>
        </div>
        {error && <div class="error-box">{error}</div>}
        <div class="kb-card-foot">
          <button class="primary" onClick={() => void save()} disabled={!!busy}>
            保存卡片
          </button>
          <button onClick={() => void generate()} disabled={!!busy} title="抓取摘要 + PDF 全文抽样，让模型填写各字段">
            让模型生成
          </button>
          <button onClick={remove} class="danger">
            移除文献
          </button>
          {busy && <span class="muted small">{busy}</span>}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onInput, rows = 2, hint }: { label: string; value: string; onInput: (v: string) => void; rows?: number; hint?: string }) {
  return (
    <label class="field">
      <span class="label">{label}</span>
      <div class="control">
        <textarea rows={rows} value={value || ""} onInput={(e) => onInput((e.target as HTMLTextAreaElement).value)} />
        {hint && <div class="hint">{hint}</div>}
      </div>
    </label>
  );
}

function basisLabel(basis: string): string {
  return basis === "fulltext" ? "模型读全文" : basis === "metadata" ? "元数据抓取" : basis === "manual" ? "手动编辑" : basis || "-";
}
