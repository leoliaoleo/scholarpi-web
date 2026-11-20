/**
 * Knowledge-base tools for the agent: collections, tags, structured metadata cards,
 * cross-paper search, arXiv/DOI import and JSON/BibTeX export. These are the same
 * operations the left rail exposes, so a chat instruction ("把这 5 篇归到 Transformer
 * 演进 里") and a click keep the library in the same state.
 */
import { Type } from "@earendil-works/pi-ai";
import { getSettings } from "../config";
import {
  cardView,
  collectionAdd,
  collectionsOf,
  createCollection,
  exportBackup,
  exportBibtex,
  generateCard,
  importBlock,
  libraryStats,
  listCards,
  listCollections,
  saveCard,
  searchLibrary,
  setPaperTags,
  tagsIndex,
  tagsOf,
  type Collection,
  type PaperCard,
} from "../library";
import { parseIdentifiers } from "../library-util";
import { getItem, listPapers, paperTitle } from "../paper";
import { clip, ok, tool, type Tool, type ToolContext } from "./common";
import { resolvePaperItem } from "./paper-tools";

const itemKeyParam = Type.Optional(Type.String({ description: "Paper key (from kb_list / kb_search). Omit for the current paper." }));

async function findCollection(ref: string): Promise<Collection> {
  const q = String(ref || "").trim().toLowerCase();
  const rows = await listCollections();
  const hit = rows.find((c) => c.id === ref) || rows.find((c) => c.name.toLowerCase() === q) || rows.find((c) => c.name.toLowerCase().includes(q));
  if (!hit) throw new Error(`找不到专题「${ref}」。现有专题：${rows.map((c) => c.name).join(" | ") || "（暂无）"}`);
  return hit;
}

function line(itemKey: string): string {
  const it = getItem(itemKey);
  if (!it) return `- item_key=${itemKey} | (已不在库中)`;
  return `- item_key=${itemKey} | ${paperTitle(it)} | ${it.year || "?"} | ${it.source}${it.pdfUrl || it.source === "demo" ? " | 有PDF" : " | 无PDF"}`;
}

export function kbTools(ctx: ToolContext): Tool[] {
  const overview = tool({
    name: "kb_overview",
    label: "知识库概览",
    description:
      "Personal knowledge base at a glance: paper counts, the user's research collections (topics) with member counts, and the most used tags. Call before doing library work.",
    parameters: Type.Object({}),
    async execute() {
      const [stats, cols, cards] = await Promise.all([libraryStats(), listCollections(), listCards()]);
      const lines = [
        `papers: ${stats.papers} (demo ${stats.demo}, user ${stats.mine}) | collections: ${stats.collections} | cards with analysis: ${stats.cards} | tags: ${stats.tags}`,
        "",
        "Collections:",
        ...(cols.length
          ? cols.map((c) => `- ${c.id} | ${c.name} | ${c.itemKeys.length} papers${c.description ? ` | ${clip(c.description, 90)}` : ""}`)
          : ["- (none yet — create one with kb_create_collection)"]),
        "",
        "Tag cloud:",
        ...(await topTags()),
      ];
      const noCard = listPapers().filter((p) => !cards.some((c) => c.itemKey === p.itemKey && (c.method || c.summary || c.metrics)));
      if (noCard.length) lines.push("", `${noCard.length} papers have no metadata card yet (kb_generate_card fills one).`);
      return ok(lines.join("\n"), stats);
    },
  });

  const list = tool({
    name: "kb_list",
    label: "文献清单",
    description: "List library papers, optionally only those in a collection or carrying a tag. Gives the item_key values every other tool needs.",
    parameters: Type.Object({
      collection: Type.Optional(Type.String({ description: "Collection id or name" })),
      tag: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number({ description: "Default 40" })),
    }),
    async execute(_id, p) {
      let rows = listPapers();
      if (p.collection) {
        const c = await findCollection(p.collection);
        rows = rows.filter((r) => c.itemKeys.includes(r.itemKey));
      }
      if (p.tag) {
        const cards = await listCards();
        const t = p.tag.toLowerCase();
        rows = rows.filter((r) => tagsOf(r, cards.find((c) => c.itemKey === r.itemKey)).some((x) => x.toLowerCase().includes(t)));
      }
      if (!rows.length) return ok(`No papers match that filter (${p.collection ? `collection=${p.collection}` : ""}${p.tag ? ` tag=${p.tag}` : ""}).`, { count: 0 });
      const out = rows.slice(0, p.limit || 40).map((it) => line(it.itemKey));
      if (rows.length > out.length) out.push(`… ${rows.length - out.length} more`);
      return ok(out.join("\n"), { count: rows.length });
    },
  });

  const createCollectionTool = tool({
    name: "kb_create_collection",
    label: "新建研究专题",
    description: 'Create a research topic / collection the user can browse in the left rail. Add papers to it with kb_add_to_collection.',
    parameters: Type.Object({
      name: Type.String({ description: "Topic name, e.g. '高效微调方法'" }),
      description: Type.Optional(Type.String()),
      color: Type.Optional(Type.String({ description: "#rrggbb" })),
    }),
    async execute(_id, p) {
      const row = await createCollection(p.name, p.description || "", /^#[0-9a-f]{6}$/i.test(p.color || "") ? p.color! : "");
      ctx.notify({ type: "library-changed" });
      return ok(`Collection created: ${row.name} (id=${row.id})`, { id: row.id });
    },
  });

  const addToCollection = tool({
    name: "kb_add_to_collection",
    label: "加入专题",
    description: "Put papers into a collection (accepts its id or name). Use after a literature survey to file what was found.",
    parameters: Type.Object({
      collection: Type.String(),
      item_keys: Type.Array(Type.String(), { description: "Keys from kb_list / kb_search / kb_import" }),
    }),
    async execute(_id, p) {
      const c = await findCollection(p.collection);
      const known = p.item_keys.filter((k) => !!getItem(k));
      if (!known.length) throw new Error(`这些 item_key 都不在库中：${p.item_keys.join(", ")}`);
      const row = await collectionAdd(c.id, known);
      ctx.notify({ type: "library-changed" });
      return ok(`"${row?.name}" now holds ${row?.itemKeys.length} papers (added ${known.length}, skipped ${p.item_keys.length - known.length} unknown).`, {
        id: c.id,
      });
    },
  });

  const setTags = tool({
    name: "kb_set_tags",
    label: "设置标签",
    description: "Replace a paper's user tags (comma separated). Tags are what kb_list can filter by.",
    parameters: Type.Object({ item_key: itemKeyParam, tags: Type.String({ description: "e.g. 'CV, 经典, 需复现'" }) }),
    async execute(_id, p) {
      const item = resolvePaperItem(ctx, p.item_key);
      const saved = await setPaperTags(item.itemKey, p.tags.split(/[,，;；、]/).map((s) => s.trim()));
      ctx.notify({ type: "library-changed" });
      return ok(`Tags of "${paperTitle(item)}": ${saved.join(", ") || "(none)"}`, { tags: saved });
    },
  });

  const readCard = tool({
    name: "kb_card",
    label: "读取元数据卡片",
    description:
      "Read a paper's structured knowledge card: title/authors/year/venue/DOI plus 核心方法、数据集、关键指标、一句话总结、关键词. This is the fast way to recall what a stored paper is about.",
    parameters: Type.Object({ item_key: itemKeyParam, all: Type.Optional(Type.Boolean({ description: "List one-line summaries of every carded paper" })) }),
    async execute(_id, p) {
      if (p.all) {
        const rows = await listCards();
        const withContent = rows.filter((c) => c.summary || c.method || c.metrics);
        if (!withContent.length) return ok("No metadata cards yet — run kb_generate_card per paper.", { count: 0 });
        return ok(
          withContent
            .map((c) => `- item_key=${c.itemKey} | ${clip(c.title, 70)} | 方法: ${clip(c.method, 120)} | 指标: ${clip(c.metrics, 120)} | 一句话: ${clip(c.summary, 90)}`)
            .join("\n"),
          { count: withContent.length },
        );
      }
      const item = resolvePaperItem(ctx, p.item_key);
      const card = await cardView(item);
      const cols = await collectionsOf(item.itemKey);
      const lines = [
        `${card.title}`,
        `authors: ${card.authors}`,
        `year: ${card.year} | venue: ${card.venue} | DOI: ${card.DOI}${card.citations ? ` | cited by ${card.citations}` : ""}`,
        `url: ${card.url}${card.pdfUrl ? `\npdf: ${card.pdfUrl}` : "\npdf: (无直链)"}`,
        `tags: ${tagsOf(item, card).join(", ") || "(无)"}${cols.length ? ` | collections: ${cols.map((c) => c.name).join(" / ")}` : ""}`,
        `card source: ${card.basis || "none"} (updated ${card.updatedAt ? new Date(card.updatedAt).toISOString().slice(0, 10) : "-"})`,
        "",
        `核心方法 method: ${card.method || "(未填写)"}`,
        `数据集 datasets: ${card.datasets || "(未填写)"}`,
        `关键指标 metrics: ${card.metrics || "(未填写)"}`,
        `一句话总结 summary: ${card.summary || "(未填写)"}`,
        `关键词 keywords: ${card.keywords || "(未填写)"}`,
        "",
        `abstract: ${clip(card.abstract, 1200) || "(无)"}`,
      ];
      return ok(lines.join("\n"), { itemKey: item.itemKey, hasCard: !!(card.method || card.summary) });
    },
  });

  const updateCard = tool({
    name: "kb_update_card",
    label: "更新元数据卡片",
    description:
      "Write fields into a paper's metadata card (only the fields you pass). Use after reading a paper to persist 核心方法 / 数据集 / 关键指标 / 一句话总结 / 关键词.",
    parameters: Type.Object({
      item_key: itemKeyParam,
      method: Type.Optional(Type.String()),
      datasets: Type.Optional(Type.String()),
      metrics: Type.Optional(Type.String()),
      summary: Type.Optional(Type.String({ description: "one-line takeaway, ≤ 60 chars" })),
      keywords: Type.Optional(Type.String({ description: "comma separated search keywords" })),
    }),
    async execute(_id, p) {
      const item = resolvePaperItem(ctx, p.item_key);
      const old = await cardView(item);
      const patch: Partial<PaperCard> = { itemKey: item.itemKey, basis: "manual" };
      for (const k of ["method", "datasets", "metrics", "summary", "keywords"] as const) {
        const v = (p as any)[k];
        if (typeof v === "string" && v.trim()) (patch as any)[k] = v.trim();
      }
      const { saveCard } = await import("../library");
      const saved = await saveCard({ ...old, ...patch, updatedAt: Date.now() }, true);
      ctx.notify({ type: "cards-changed", itemKey: item.itemKey });
      return ok(`Card updated for "${paperTitle(item)}": ${Object.keys(patch).filter((k) => k !== "itemKey" && k !== "basis" && k !== "updatedAt").join(", ")}`, {
        itemKey: saved.itemKey,
      });
    },
  });

  const generate = tool({
    name: "kb_generate_card",
    label: "自动生成元数据卡片",
    description:
      "Ask the model to fill a paper's card from its abstract plus a spread of its pages (核心方法/数据集/关键指标/一句话总结/关键词). One model call per paper; full_text=false keeps it to the abstract only.",
    parameters: Type.Object({
      item_key: itemKeyParam,
      full_text: Type.Optional(Type.Boolean({ description: "Default true: sample the PDF text too" })),
    }),
    async execute(_id, p) {
      const item = resolvePaperItem(ctx, p.item_key);
      const card = await generateCard(item.itemKey, { fullText: p.full_text !== false });
      ctx.notify({ type: "cards-changed", itemKey: item.itemKey });
      return ok(
        `Card generated for "${paperTitle(item)}" from ${card.basis}:\n方法: ${clip(card.method, 300)}\n数据集: ${clip(card.datasets, 200)}\n指标: ${clip(card.metrics, 300)}\n一句话: ${card.summary}`,
        { itemKey: item.itemKey },
      );
    },
  });

  const search = tool({
    name: "kb_search",
    label: "知识库全局检索",
    description:
      "Search ACROSS the whole library (or one collection) with BM25 over titles, abstracts, tags and card fields, plus model-expanded synonyms so a Chinese question finds English text. full_text=true also indexes PDF text (slower).",
    parameters: Type.Object({
      query: Type.String(),
      collection: Type.Optional(Type.String({ description: "Restrict to one collection" })),
      full_text: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Number({ description: "Default 10, max 30" })),
    }),
    async execute(_id, p) {
      const itemKeys = p.collection ? (await findCollection(p.collection)).itemKeys : undefined;
      const r = await searchLibrary({ query: p.query, itemKeys, fullText: !!p.full_text, limit: Math.min(p.limit || 10, 30) });
      if (!r.hits.length) return ok(`知识库中没有匹配「${p.query}」的文献（引擎 ${r.engine}）。`, { count: 0 });
      const lines = r.hits.map(
        (h, i) =>
          `${i + 1}. item_key=${h.itemKey} | ${h.title}${h.year ? ` (${h.year})` : ""}${h.venue ? ` | ${clip(h.venue, 40)}` : ""}\n   ${clip(h.authors, 90)}${h.tags.length ? ` | tags: ${h.tags.join(",")}` : ""}${h.collections.length ? ` | ${h.collections.join("/")}` : ""}${h.pdf ? "" : " | 无PDF"}\n   命中字段: ${h.fields.slice(0, 4).join(", ") || "-"}\n   ${clip(h.snippet, 500)}`,
      );
      return ok(`共 ${r.total} 条相关，取前 ${r.hits.length} 条（引擎 ${r.engine}${r.expanded ? `，扩展词：${clip(r.expanded, 160)}` : ""}）\n\n${lines.join("\n")}`, {
        count: r.hits.length,
        engine: r.engine,
      });
    },
  });

  const importTool = tool({
    name: "kb_import",
    label: "批量导入文献",
    description:
      "Import papers into the library by arXiv id / arXiv or DOI link / PDF url (metadata fetched through the relay; the PDF loads when opened). Ids may be separated by commas, spaces or newlines. Optionally file them straight into a collection.",
    parameters: Type.Object({
      ids: Type.String({ description: "e.g. '2001.08361, 10.1109/CVPR.2016.90'" }),
      collection: Type.Optional(Type.String()),
      with_card: Type.Optional(Type.Boolean({ description: "Also generate the metadata card (one model call each)" })),
    }),
    async execute(_id, p) {
      const target = p.collection ? await findCollection(p.collection) : null;
      const wanted = parseIdentifiers(p.ids);
      const rows = await importBlock(p.ids, { collectionId: target?.id, signal: undefined, withCard: p.with_card });
      ctx.notify({ type: "library-changed" });
      const outs = rows.map((r) => `- ${r.input} → ${r.ok ? `${r.action === "existing" ? "已存在" : "已入库"} item_key=${r.itemKey} | ${clip(r.title, 80)}${r.pdf ? " | 有PDF" : " | 无PDF直链"}` : `失败：${r.note}`}`);
      const okCount = rows.filter((r) => r.ok).length;
      const pending = p.with_card ?? getSettings().kbAutoCard;
      return ok(
        `导入 ${okCount}/${wanted.length} 篇（元数据已入库，PDF 与 AI 卡片在后台补）${target ? ` → 专题「${target.name}」` : ""}\n\n${outs.join("\n")}${
          pending && okCount ? "\n\n卡片正在后台逐篇生成，稍后刷新即可看到方法/数据集/指标。" : ""
        }`,
        { added: okCount, cards: pending ? "background" : undefined },
      );
    },
  });

  const exportTool = tool({
    name: "kb_export",
    label: "导出知识库",
    description:
      "Export the knowledge base: format 'bibtex' gives a .bib (whole library or given keys), 'json' gives the full backup (papers, collections, cards, annotations — without PDF bytes). Print the result for the user to save, or summarise it.",
    parameters: Type.Object({
      format: Type.Union([Type.Literal("bibtex"), Type.Literal("json")]),
      item_keys: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, p) {
      const text = p.format === "json" ? await exportBackup() : await exportBibtex(p.item_keys);
      const head = p.format === "json" ? `JSON 备份（${text.length} 字符，不含 PDF 二进制）：` : `BibTeX（${(text.match(/^@/gm) || []).length} 条）：`;
      return ok(`${head}\n\n${clip(text, 12000)}`, { bytes: text.length, format: p.format });
    },
  });

  return [overview, list, createCollectionTool, addToCollection, setTags, readCard, updateCard, generate, search, importTool, exportTool];
}

async function topTags(): Promise<string[]> {
  const rows = await tagsIndex();
  if (!rows.length) return ["- (no tags yet)"];
  return [`- ${rows.slice(0, 12).map((t) => `${t.tag}(${t.count})`).join(" · ")}`];
}
