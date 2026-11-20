/**
 * Progressive-disclosure access to the current paper (or any other paper via item_key):
 * overview → search → read pages/sections.
 */
import { Type } from "@earendil-works/pi-ai";
import { getAnnotations } from "../annotate";
import { getSettings } from "../config";
import { getItem, getPaperText, paperMetadata, resolveItemKey, type Paper } from "../paper";
import { listSessionsForPaper } from "../store";
import { searchPages, sliceWithHint } from "../text";
import { paperKey, viewerState } from "../viewer-state";
import { clip, ok, parsePages, tool, type Tool, type ToolContext } from "./common";
import { textLayerNotice } from "../../shared/errors";

const itemKeyParam = Type.Optional(
  Type.String({ description: "Key of another paper in the workspace (see library_search). Omit for the current paper." }),
);

export function resolvePaperItem(ctx: ToolContext, itemKey?: string): Paper {
  const item = itemKey ? resolveItemKey(itemKey) : getItem(ctx.paper);
  if (!item) throw new Error(itemKey ? `找不到文献 ${itemKey}，请先用 library_search 获取正确的 item_key` : "当前文献不存在");
  return item;
}

export function paperTools(ctx: ToolContext): Tool[] {
  const overview = tool({
    name: "paper_overview",
    label: "论文概览",
    description:
      "Get a paper's metadata, abstract, page count, detected section headings (with page numbers) and annotation/session counts. Call this first before reading a paper; the full text is not in your context.",
    parameters: Type.Object({ item_key: itemKeyParam }),
    async execute(_id, p) {
      const item = resolvePaperItem(ctx, p.item_key);
      const meta = paperMetadata(item);
      const text = await getPaperText(item);
      const anns = await getAnnotations(item);
      const sessions = await listSessionsForPaper(item.libraryID, item.itemKey);
      const lines = Object.entries(meta).map(([k, v]) => `${k}: ${k === "abstract" ? v : clip(v, 300)}`);
      const chars = text.pages.reduce((n, s) => n + s.length, 0);
      lines.push(`text source: ${text.source}, pages: ${text.totalPages}, characters: ${chars}`);
      const noText = textLayerNotice(text.totalPages, chars);
      if (noText) lines.push(noText);
      if (!p.item_key || p.item_key === ctx.paper.itemKey) {
        if (viewerState.paperKey === paperKey(ctx.paper) && viewerState.currentPage > 0)
          lines.push(`user is currently viewing page: ${viewerState.currentPage}`);
      }
      if (text.headings.length) {
        lines.push("", "Detected sections (title — page):");
        for (const h of text.headings.slice(0, 80)) lines.push(`- ${h.title} — p.${h.page + 1}`);
      } else if (text.source !== "none") {
        lines.push("", "No section headings detected; use paper_search or read by pages.");
      }
      lines.push("", `annotations: ${anns.length}; AI chat sessions about this paper: ${sessions.length}`);
      return ok(lines.join("\n"), { pages: text.totalPages, headings: text.headings.length });
    },
  });

  const read = tool({
    name: "paper_read",
    label: "阅读论文",
    description:
      "Read part of a paper's full text by pages (1-based, e.g. '3' or '3-5') or by section title (from paper_overview). Output is truncated; pass offset (from the previous result) to continue. Prefer paper_search to locate passages before reading.",
    parameters: Type.Object({
      item_key: itemKeyParam,
      pages: Type.Optional(Type.String({ description: "Page(s) to read, 1-based: '4', '4-6', '2,5'" })),
      section: Type.Optional(Type.String({ description: "Section title (or part of it) to read, e.g. 'Method'" })),
      offset: Type.Optional(Type.Number({ description: "Character offset to continue from" })),
    }),
    async execute(_id, p) {
      const item = resolvePaperItem(ctx, p.item_key);
      const text = await getPaperText(item);
      if (!text.pages.length) throw new Error("该文献没有可读取的全文（没有 PDF 附件或尚未索引）");
      if (!text.pages.reduce((n, s) => n + s.length, 0)) {
        throw new Error(`这篇 PDF 有 ${text.totalPages} 页但没有文字层（很可能是扫描件或图片版），无法读取原文。请改用 arXiv 上的文字版 PDF 或先做 OCR；在此之前不要输出 [p. x] 页码引用。`);
      }
      const max = getSettings().maxReadChars;
      let body = "";
      let label = "";
      if (p.section) {
        const q = p.section.toLowerCase().trim();
        const hs = text.headings;
        const i = hs.findIndex((h) => h.title.toLowerCase().includes(q));
        if (i === -1) {
          throw new Error(`没有找到标题包含 "${p.section}" 的章节。可用章节：${hs.map((h) => h.title).slice(0, 40).join(" | ") || "（无）"}`);
        }
        const h = hs[i];
        const next = hs[i + 1];
        const chunks: string[] = [];
        for (let pg = h.page; pg < text.pages.length; pg++) {
          const startOff = pg === h.page ? h.offset : 0;
          const endOff = next && next.page === pg ? next.offset : text.pages[pg].length;
          chunks.push(`[Page ${pg + 1}]\n${text.pages[pg].slice(startOff, endOff)}`);
          if (next && next.page <= pg) break;
          if (pg - h.page > 15) break;
        }
        body = chunks.join("\n\n");
        label = `section "${h.title}"`;
      } else {
        const idx = p.pages ? parsePages(p.pages, text.pages.length) : [0];
        if (!idx.length) throw new Error(`页码无效，论文共 ${text.pages.length} 页`);
        body = idx.map((i) => `[Page ${i + 1}]\n${text.pages[i]}`).join("\n\n");
        label = `pages ${p.pages || "1"}`;
      }
      const s = sliceWithHint(body, p.offset || 0, max);
      const tail =
        s.nextOffset !== null
          ? `\n\n[Truncated: showing chars ${p.offset || 0}-${s.nextOffset} of ${s.total}. Call paper_read again with the same arguments and offset=${s.nextOffset} to continue.]`
          : "";
      return ok(`(${label} of ${text.totalPages} pages)\n\n${s.text}${tail}`, { chars: s.text.length });
    },
  });

  const search = tool({
    name: "paper_search",
    label: "论文内搜索",
    description:
      "Search inside a paper's full text for a phrase or keywords; returns matching snippets with page numbers. Use English terms for English papers.",
    parameters: Type.Object({
      query: Type.String({ description: "Phrase or keywords" }),
      item_key: itemKeyParam,
      max_results: Type.Optional(Type.Number({ description: "Default 8, max 20" })),
    }),
    async execute(_id, p) {
      const item = resolvePaperItem(ctx, p.item_key);
      const text = await getPaperText(item);
      if (!text.pages.length) throw new Error("该文献没有可搜索的全文");
      if (!text.pages.reduce((n, s) => n + s.length, 0)) {
        throw new Error(`这篇 PDF 没有文字层（扫描件或图片版），无法在原文中搜索，也没有可引用的页码。请说明原文不可核验，不要输出 [p. x]。`);
      }
      const hits = searchPages(text.pages, p.query, Math.min(p.max_results || 8, 20));
      if (!hits.length) return ok(`No matches for "${p.query}". Try different or fewer keywords.`, { count: 0 });
      return ok(hits.map((h, i) => `${i + 1}. [p.${h.page + 1}] ${h.text}`).join("\n\n"), { count: hits.length });
    },
  });

  const annotations = tool({
    name: "get_annotations",
    label: "查看批注",
    description: "List highlights, underlines and notes the user (or AI) made on a paper, with page, color, text, comment and annotation key.",
    parameters: Type.Object({
      item_key: itemKeyParam,
      filter: Type.Optional(Type.String({ description: "Only annotations whose text/comment contains this" })),
    }),
    async execute(_id, p) {
      const item = resolvePaperItem(ctx, p.item_key);
      let anns = await getAnnotations(item);
      if (p.filter) {
        const f = p.filter.toLowerCase();
        anns = anns.filter((a) => (a.text + " " + a.comment).toLowerCase().includes(f));
      }
      if (!anns.length) return ok("No annotations.", { count: 0 });
      const lines = anns.slice(0, 150).map(
        (a) =>
          `- [${a.key}] p.${a.page} ${a.type} ${a.color}${a.tags.length ? ` tags:${a.tags.join(",")}` : ""}` +
          (a.text ? `\n  text: ${clip(a.text, 500)}` : "") +
          (a.comment ? `\n  comment: ${clip(a.comment, 500)}` : ""),
      );
      if (anns.length > 150) lines.push(`… ${anns.length - 150} more`);
      return ok(lines.join("\n"), { count: anns.length });
    },
  });

  return [overview, search, read, annotations];
}
