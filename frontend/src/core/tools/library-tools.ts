/**
 * Workspace-wide tools: find papers in the workbench, read past AI sessions
 * (+ their conclusions), search annotations across papers, save notes.
 */
import { Type } from "@earendil-works/pi-ai";
import { createStandaloneNote, searchAllAnnotations } from "../annotate";
import { creatorsString, getItem, getPaperText, listPapers, paperTitle, type Paper } from "../paper";
import * as store from "../store";
import { clip, ok, tool, type Tool, type ToolContext } from "./common";
import { resolvePaperItem } from "./paper-tools";

function messageText(m: any): string {
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return m.content
    .map((c: any) => (c.type === "text" ? c.text : c.type === "toolCall" ? `[tool: ${c.name}]` : ""))
    .filter(Boolean)
    .join("\n");
}

function words(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesWords(fields: string[], ws: string[]): boolean {
  const hay = fields.join(" ").toLowerCase();
  return !ws.length || ws.every((w) => hay.includes(w));
}

export function libraryTools(ctx: ToolContext): Tool[] {
  const librarySearch = tool({
    name: "library_search",
    label: "检索工作区文献",
    description:
      "Search the papers in this workbench (uploaded PDFs, arXiv links, demo papers). mode 'titleCreatorYear' (default) matches title/author/year; 'fields' also matches venue, abstract and tags; 'everything' also searches indexed full text (slow). Returns keys usable with paper_* tools.",
    parameters: Type.Object({
      query: Type.String(),
      mode: Type.Optional(Type.Union([Type.Literal("titleCreatorYear"), Type.Literal("fields"), Type.Literal("everything")])),
      limit: Type.Optional(Type.Number({ description: "Default 15, max 50" })),
    }),
    async execute(_id, p) {
      const limit = Math.min(p.limit || 15, 50);
      const mode = p.mode || "titleCreatorYear";
      const q = words(p.query);
      const fields = (it: Paper) =>
        mode === "titleCreatorYear" ? [it.title, it.authors, it.year] : [it.title, it.authors, it.year, it.venue, it.abstract, it.tags];
      let scored = listPapers()
        .filter((it) => matchesWords(fields(it), q))
        .map((it) => ({ it, n: q.reduce((s, w) => s + (it.title.toLowerCase().includes(w) ? 2 : 0), 0) }))
        .sort((a, b) => b.n - a.n)
        .slice(0, limit)
        .map((x) => x.it);
      if (!scored.length && mode === "everything") {
        for (const it of listPapers()) {
          if (scored.length >= limit) break;
          const text = await getPaperText(it);
          if (matchesWords([...fields(it), text.pages.join(" ")], q)) scored.push(it);
        }
      }
      if (!scored.length) return ok(`No papers match "${p.query}" in this workbench.`, { count: 0 });
      const lines: string[] = [];
      for (const it of scored) {
        const n = (await store.listSessionsForPaper(it.libraryID, it.itemKey)).length;
        lines.push(
          `- item_key=${it.itemKey} | ${paperTitle(it)} | ${creatorsString(it, 3)} | ${it.year}${it.venue ? ` | ${clip(it.venue, 60)}` : ""}` +
            `${it.source === "demo" ? " | built-in demo" : " | " + it.source}${n ? ` | ${n} AI sessions` : ""}${it.itemKey === ctx.paper.itemKey ? " | (current paper)" : ""}`,
        );
      }
      return ok(lines.join("\n"), { count: scored.length });
    },
  });

  const listSessions = tool({
    name: "list_sessions",
    label: "查看历史会话",
    description:
      "List past AI chat sessions with their conclusions. With item_key: sessions about that paper. Otherwise: recent sessions about OTHER papers, optionally filtered by query (matches titles, conclusions and message text).",
    parameters: Type.Object({
      item_key: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number({ description: "Default 15" })),
    }),
    async execute(_id, p) {
      let sessions: store.SessionMeta[];
      if (p.item_key) {
        const item = resolvePaperItem(ctx, p.item_key);
        sessions = await store.listSessionsForPaper(item.libraryID, item.itemKey);
      } else {
        sessions = await store.searchSessions({ query: p.query, excludeItemKey: ctx.paper.itemKey, limit: p.limit || 15 });
      }
      sessions = sessions.filter((s) => s.id !== ctx.sessionId && s.messageCount > 0);
      if (!sessions.length) return ok("No matching sessions.", { count: 0 });
      const lines = sessions.map(
        (s) =>
          `- session_id=${s.id} | paper: ${clip(s.paperTitle, 80)} (item_key=${s.itemKey}) | "${s.title || "untitled"}" | ${new Date(s.updated).toISOString().slice(0, 10)} | ${s.messageCount} msgs` +
          (s.conclusion ? `\n  conclusion: ${clip(s.conclusion, 600)}` : ""),
      );
      return ok(lines.join("\n"), { count: sessions.length });
    },
  });

  const readSession = tool({
    name: "read_session",
    label: "阅读历史会话",
    description: "Read the user/assistant messages of a past session (from list_sessions). Output is truncated; use offset to continue.",
    parameters: Type.Object({ session_id: Type.String(), offset: Type.Optional(Type.Number()) }),
    async execute(_id, p) {
      const meta = await store.getSession(p.session_id);
      if (!meta) throw new Error(`会话 ${p.session_id} 不存在`);
      const msgs = await store.loadMessages(p.session_id);
      const body = msgs
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${messageText(m)}`)
        .filter((s) => s.trim().length > 12)
        .join("\n\n");
      const off = p.offset || 0;
      const chunk = body.slice(off, off + 8000);
      const next = off + 8000 < body.length ? `\n\n[Truncated; continue with offset=${off + 8000}]` : "";
      return ok(`Session "${meta.title}" about "${meta.paperTitle}"\nConclusion: ${meta.conclusion || "(none)"}\n\n${chunk}${next}`);
    },
  });

  const searchAnnotations = tool({
    name: "search_annotations",
    label: "搜索全部批注",
    description: "Search highlight text and comments across ALL papers in this workbench.",
    parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number({ description: "Default 30" })) }),
    async execute(_id, p) {
      const hits = await searchAllAnnotations(p.query, Math.min(p.limit || 30, 100));
      if (!hits.length) return ok(`No annotations match "${p.query}".`, { count: 0 });
      const lines = hits.map(({ ann, paper }) => {
        const key = paper ? paper.itemKey : ann.itemKey;
        return (
          `- [${ann.key}] ${clip(paperTitle(paper), 70)} (item_key=${key}) p.${ann.pageLabel || "?"} ${ann.type}` +
          (ann.text ? `\n  text: ${clip(ann.text, 300)}` : "") +
          (ann.comment ? `\n  comment: ${clip(ann.comment, 300)}` : "")
        );
      });
      return ok(lines.join("\n"), { count: hits.length });
    },
  });

  const saveConclusion = tool({
    name: "save_conclusion",
    label: "记录会话结论",
    description:
      "Record the key conclusions of THIS session (concise bullet points). Conclusions are visible to future sessions about other papers. Use when the user reaches an insight or asks to remember something.",
    parameters: Type.Object({ conclusion: Type.String() }),
    async execute(_id, p) {
      await store.updateSession(ctx.sessionId, { conclusion: p.conclusion.trim() });
      ctx.notify({ type: "session-updated" });
      return ok("Conclusion saved.");
    },
  });

  const createNote = tool({
    name: "create_note",
    label: "保存笔记",
    description:
      "Save a markdown note (LaTeX math allowed) attached to a paper — default the current paper. It appears as a sticky note in the reader and in the notes panel. Use only when the user asks to save notes or summaries.",
    parameters: Type.Object({
      markdown: Type.String(),
      title: Type.Optional(Type.String()),
      item_key: Type.Optional(Type.String()),
    }),
    executionMode: "sequential",
    async execute(_id, p) {
      const parent = p.item_key ? resolvePaperItem(ctx, p.item_key) : getItem(ctx.paper);
      if (!parent) throw new Error("找不到要附加笔记的文献");
      const r = await createStandaloneNote(parent, p.markdown, p.title || "");
      ctx.notify({ type: "note-created", key: r.key, itemKey: parent.itemKey });
      return ok(`Note saved (${r.key}) under "${paperTitle(parent)}".`, { key: r.key });
    },
  });

  return [librarySearch, listSessions, readSession, searchAnnotations, saveConclusion, createNote];
}
