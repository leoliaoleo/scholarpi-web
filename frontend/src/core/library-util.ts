/**
 * Pure helpers for the knowledge base: tags, tokenising, BM25 scoring, BibTeX and
 * backup payloads. No browser or IndexedDB imports, so `npm test` covers them.
 */

// ---------------------------------------------------------------------------
// tags

export function normalizeTag(raw: string): string {
  return String(raw || "")
    .replace(/[/\\]/g, "·")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

/** Tags are stored on the paper as one delimited string (Zotero-shaped, backwards compatible). */
export function splitTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return dedupeTags(raw.map((t) => normalizeTag(String(t))));
  const out = dedupeTags(
    String(raw ?? "")
      .split(/[,;；，、]/)
      .map((t) => normalizeTag(t)),
  );
  return out;
}

export function joinTags(tags: string[]): string {
  return dedupeTags(tags.map((t) => normalizeTag(t))).join(", ");
}

export function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const k = t.toLocaleLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// tokenising (latin words + CJK bigrams, so Chinese queries hit Chinese cards)

const WORD = /[a-z0-9]+|[\u4e00-\u9fff]+/gi;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text || "").toLowerCase().match(WORD) || []) {
    if (/^[a-z0-9]/.test(m)) {
      out.push(m);
      continue;
    }
    if (m.length === 1) out.push(m);
    else for (let i = 0; i + 2 <= m.length; i++) out.push(m.slice(i, i + 2));
  }
  return out;
}

/** Words the user typed, kept as phrases for the idf path (CJK runs stay together). */
export function queryTerms(query: string): string[] {
  const out: string[] = [];
  for (const m of String(query || "").toLowerCase().match(WORD) || []) {
    if (/^[a-z0-9]/.test(m) || m.length > 1) out.push(m);
  }
  return dedupeStrings(out);
}

export function dedupeStrings(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

// ---------------------------------------------------------------------------
// BM25 over weighted fields

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/** A searchable document: field name → text, with the item key it belongs to. */
export interface Bm25Doc {
  id: string;
  fields: Record<string, string>;
}

export interface Bm25Options {
  /** Field name → weight; an unlisted field weighs 1. */
  weights?: Record<string, number>;
}

interface PreparedDoc {
  id: string;
  len: number;
  tf: Map<string, number>;
  /** Raw text per field, for the exact-phrase bonus. */
  raw: Record<string, string>;
}

function prepare(docs: Bm25Doc[], weights: Record<string, number>): PreparedDoc[] {
  return docs.map((d) => {
    const tf = new Map<string, number>();
    let len = 0;
    for (const [name, text] of Object.entries(d.fields)) {
      const w = weights[name] ?? 1;
      for (const t of tokenize(text)) {
        len += w;
        tf.set(t, (tf.get(t) || 0) + w);
      }
    }
    return { id: d.id, len, tf, raw: d.fields };
  });
}

/**
 * Rank `docs` for `query`. Field weights apply per occurrence, an exact phrase adds a
 * flat bonus, and a document matching every distinctive term is never outranked by one
 * matching a single stopword-ish token.
 */
export function bm25(query: string, docs: Bm25Doc[], opts: Bm25Options = {}): { id: string; score: number }[] {
  const weights = opts.weights || {};
  const terms = queryTerms(query);
  if (!terms.length || !docs.length) return [];
  const prepared = prepare(docs, weights);
  const avg = prepared.reduce((s, d) => s + d.len, 0) / prepared.length || 1;
  const n = prepared.length;

  const scored = prepared.map((d) => {
    let score = 0;
    for (const term of terms) {
      const df = prepared.filter((x) => x.tf.has(term)).length;
      if (!df) continue;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      const tf = d.tf.get(term) || 0;
      score += (idf * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (d.len / avg)));
    }
    const phrase = query.trim().toLocaleLowerCase();
    if (phrase.length > 4) {
      for (const [name, text] of Object.entries(d.raw)) {
        if (text && text.toLocaleLowerCase().includes(phrase)) score += 3 * (weights[name] ?? 1);
      }
    }
    // Everything the user asked for should be present; missing terms cost the lead.
    const covered = terms.filter((t) => d.tf.has(t)).length / terms.length;
    return { id: d.id, score: score * (0.35 + 0.65 * covered) };
  });

  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// BibTeX

const BIB_TYPES: Record<string, string> = {
  article: "article",
  journal: "article",
  conference: "inproceedings",
  inproceedings: "inproceedings",
  proceedings: "inproceedings",
  preprint: "misc",
  misc: "misc",
  thesis: "phdthesis",
  book: "book",
};

/** `firstauthor2016keyword`, suffixed with a letter when it collides. */
export function bibtexKey(item: { title?: string; authors?: string; year?: string }, taken: Set<string> = new Set()): string {
  const last = splitAuthorList(item.authors || "")[0] || "anon";
  const surname = last.split(/\s+/).filter(Boolean).slice(-1)[0] || "anon";
  const word = tokenize(item.title || "").find((t) => /^[a-z]{4,}$/.test(t)) || "paper";
  const year = (String(item.year || "").match(/\d{4}/) || [""])[0];
  let key = `${surname.toLowerCase().replace(/[^a-z]/g, "")}${year}${word}`;
  if (taken.has(key)) {
    let n = 1;
    while (taken.has(`${key}${String.fromCharCode(96 + n)}`)) n++;
    key = `${key}${String.fromCharCode(96 + Math.min(n, 26))}`;
  }
  return key;
}

function splitAuthorList(raw: string): string[] {
  return String(raw || "")
    .split(/;|,|&|\band\b|\be t al\b/i)
    .map((s) => s.trim())
    .filter((s) => s && !/^et al$/i.test(s));
}

export interface BibEntry {
  itemKey: string;
  title: string;
  authors: string;
  year: string;
  venue: string;
  DOI: string;
  url: string;
  abstract?: string;
  keywords?: string;
  type?: string;
}

/** Conference venues cite as `@inproceedings{…booktitle…}`; journals as `@article{…journal…}`. */
const CONFERENCE = /\b(cvpr|iccv|eccv|nips|neurips|icml|iclr|acl|emnlp|naacl|aaai|ijcai|kdd|sigir|siggraph|miccai|chil|interspeech|icassp|colt|aistats|uai|www|recsys|icdm|facc)\b|proceedings|symposium|conference|workshop/i;

/** One BibTeX block; arXiv-style venues degrade to `@misc` with an eprint field. */
export function toBibtex(entry: BibEntry, key: string): string {
  const venue = journalOf(entry);
  const isConf = !!venue && CONFERENCE.test(venue);
  const fields: [string, string, string][] = [
    ["title", `{${brace(entry.title)}}`, "literal"],
    ["author", entry.authors ? joinAuthors(entry.authors) : "", "literal"],
    ["year", (String(entry.year || "").match(/\d{4}/) || [""])[0], "raw"],
    ["keywords", entry.keywords || "", "literal"],
    ["abstract", (entry.abstract || "").replace(/\s+/g, " ").trim(), "literal"],
    ["doi", entry.DOI || "", "literal"],
    ["eprint", eprintOf(entry), "raw"],
    ["archiveprefix", eprintOf(entry) ? "arXiv" : "", "raw"],
    [isConf ? "booktitle" : "journal", venue, "literal"],
    ["url", entry.url || "", "literal"],
  ];
  const named = BIB_TYPES[(entry.type || "").toLowerCase()];
  const type = named || (venue ? (isConf ? "inproceedings" : "article") : "misc");
  const body = fields
    .filter(([, value]) => value)
    .map(([name, value, mode]) => `  ${name.padEnd(10)} = ${mode === "raw" ? value : `{${value}}`}`)
    .join(",\n");
  return `@${type}{${key},\n${body}\n}`;
}

export function toBibtexLibrary(entries: BibEntry[]): string {
  const taken = new Set<string>();
  return entries
    .map((e) => {
      const key = bibtexKey(e, taken);
      taken.add(key);
      return toBibtex(e, key);
    })
    .join("\n\n");
}

function brace(s: string): string {
  // Keep protected capitalisation, escape the ones BibTeX would otherwise lowercase.
  return String(s || "").replace(/([{}])/g, "\\$1").replace(/\s+/g, " ").trim();
}

function joinAuthors(raw: string): string {
  const names = splitAuthorList(raw);
  if (!names.length) return "";
  return names.map((n) => n.replace(/,\s*$/, "")).join(" and ");
}

function eprintOf(entry: BibEntry): string {
  const m = `${entry.url || ""} ${entry.DOI || ""}`.match(/arxiv[./:]\s*(?:abs\/|pdf\/)?(\d{4}\.\d{4,5}(?:v\d+)?)/i);
  if (m) return m[1];
  const doi = String(entry.DOI || "");
  const d = doi.match(/^10\.48550\/arxiv\.(\d{4}\.\d{4,5})$/i);
  return d ? d[1] : "";
}

function journalOf(entry: BibEntry): string {
  const venue = String(entry.venue || "").trim();
  if (!venue || /^arxiv$/i.test(venue)) return "";
  return venue;
}

// ---------------------------------------------------------------------------
// backup payload

export const BACKUP_KIND = "scholarpi-kb";
export const BACKUP_VERSION = 1;

export interface BackupIssue {
  path: string;
  message: string;
}

/**
 * Validate a backup file before touching IndexedDB: shape only, never destructive.
 * Returns the problems found (empty means the payload can be imported).
 */
export function inspectBackup(data: any): BackupIssue[] {
  const issues: BackupIssue[] = [];
  if (!data || typeof data !== "object") return [{ path: "", message: "备份内容不是 JSON 对象" }];
  if (data.kind && data.kind !== BACKUP_KIND) issues.push({ path: "kind", message: `不是 ScholarPi 知识库备份（kind=${String(data.kind)}）` });
  if (!Array.isArray(data.papers)) issues.push({ path: "papers", message: "缺少 papers 列表" });
  else {
    data.papers.forEach((p: any, i: number) => {
      if (!p || typeof p !== "object") issues.push({ path: `papers[${i}]`, message: "不是对象" });
      else if (typeof p.itemKey !== "string" || !p.itemKey) issues.push({ path: `papers[${i}].itemKey`, message: "缺少 itemKey" });
    });
    if (issues.length > 4) return issues.slice(0, 5);
  }
  if (data.collections != null && !Array.isArray(data.collections)) issues.push({ path: "collections", message: "collections 必须是数组" });
  if (data.cards != null && !Array.isArray(data.cards)) issues.push({ path: "cards", message: "cards 必须是数组" });
  if (data.annotations != null && !Array.isArray(data.annotations)) issues.push({ path: "annotations", message: "annotations 必须是数组" });
  return issues;
}

/** Papers carry their PDF by reference, never as bytes inside the JSON. */
export function stripPaperForBackup(p: any): any {
  const out: any = {};
  for (const k of ["itemKey", "libraryID", "title", "authors", "year", "venue", "DOI", "url", "pdfUrl", "abstract", "tags", "source", "totalPages", "addedAt"]) {
    if (p[k] !== undefined) out[k] = p[k];
  }
  return out;
}

// ---------------------------------------------------------------------------
// arXiv / DOI batch import input

/** Splits a pasted block into identifiers: ids, abs/pdf links, DOI links, plain urls. */
export function parseIdentifiers(raw: string): string[] {
  return dedupeStrings(
    String(raw || "")
      .split(/[\s,;，；]+/)
      .map((s) => s.trim().replace(/^[\s"'“‘<(\[【《]+/, "").replace(/[\s"'”’<)\]】》]+$/, ""))
      .filter((s) => s && (s.length > 3 || /^\d{4}\.\d{4,5}$/.test(s))),
  ).slice(0, 200);
}

/** Guess what the user pasted, so the right resolver runs. */
export function identifierKind(value: string): "arxiv" | "doi" | "url" {
  const s = String(value || "").trim();
  if (/^(?:arxiv:\s*)?\d{4}\.\d{4,5}(?:v\d+)?$/i.test(s)) return "arxiv";
  if (/arxiv\.org\/(?:abs|pdf|html)\//i.test(s)) return "arxiv";
  if (/^10\.\d{4,9}\/\S+$/i.test(s)) return "doi";
  if (/^doi[:\s]/i.test(s) || /doi\.org\//i.test(s)) return "doi";
  return "url";
}

/** `arxiv.org/pdf/1706.03762.pdf`, `1706.03762v5`, `arXiv:1706.03762` → `1706.03762v5`. */
export function normalizeArxivId(input: string): string {
  const s = String(input || "").trim();
  const m =
    s.match(/arxiv\.org\/(?:abs|pdf|html)\/([^?#\s]+?)(?:\.pdf)?(?:[?#].*)?$/i) ||
    s.match(/^(?:arxiv:)?\s*(\d{4}\.\d{4,5}(?:v\d+)?)$/i) ||
    s.match(/^(?:arxiv:)?\s*([a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)$/i);
  return m ? m[1] : s;
}

/** The library keys on the version-less id, so v1/v2 of one paper stay one record. */
export function arxivStableId(input: string): string {
  return normalizeArxivId(input).replace(/v\d+$/i, "");
}

export interface ImportJob {
  raw: string;
  i: number;
}

/**
 * Split a pasted batch into the three lanes the importer handles differently: arXiv ids ride
 * one `id_list` request, everything else goes through the concurrency pool, and blanks answer
 * immediately. `i` keeps each result at the position of the input that produced it.
 */
export function planImports(values: string[]): { arxiv: ImportJob[]; rest: ImportJob[]; blanks: ImportJob[] } {
  const arxiv: ImportJob[] = [];
  const rest: ImportJob[] = [];
  const blanks: ImportJob[] = [];
  values.forEach((value, i) => {
    const raw = String(value || "").trim();
    if (!raw) blanks.push({ raw: String(value ?? ""), i });
    else if (identifierKind(raw) === "arxiv") arxiv.push({ raw, i });
    else rest.push({ raw, i });
  });
  return { arxiv, rest, blanks };
}

// ---------------------------------------------------------------------------
// knowledge-base search documents

/** Field weights for cross-paper search: a title hit beats an abstract hit beats a card note. */
export const KB_WEIGHTS: Record<string, number> = { title: 4, summary: 3, method: 2.2, keywords: 2.2, tags: 2, authors: 1.6, venue: 1.2, abstract: 1.4, fulltext: 0.8 };

export interface KbPaperLike {
  itemKey: string;
  title?: string;
  authors?: string;
  year?: string;
  venue?: string;
  abstract?: string;
  tags?: string;
}

export interface KbCardLike {
  itemKey?: string;
  method?: string;
  datasets?: string;
  metrics?: string;
  summary?: string;
  keywords?: string;
  tags?: string;
  abstract?: string;
}

/**
 * One searchable document per paper: the bibliographic record, the card's analysis fields
 * and (optionally) a slice of full text. Card fields fall back to the paper record, so a
 * paper without a card is still findable by title, authors, venue and abstract.
 */
export function buildKbDocs(papers: KbPaperLike[], cards: KbCardLike[] = [], fullTexts: Record<string, string> = {}): Bm25Doc[] {
  const byKey = new Map<string, KbCardLike>();
  for (const c of cards) if (c?.itemKey) byKey.set(c.itemKey, c);
  return papers.filter((p) => p?.itemKey).map((p) => {
    const c: KbCardLike = byKey.get(p.itemKey) || {};
    const fields: Record<string, string> = {
      title: p.title || "",
      authors: p.authors || "",
      venue: p.venue || "",
      abstract: c.abstract || p.abstract || "",
      method: c.method || "",
      datasets: c.datasets || "",
      metrics: c.metrics || "",
      summary: c.summary || "",
      keywords: c.keywords || "",
      tags: [p.tags, c.tags].filter(Boolean).join(", "),
    };
    const text = fullTexts[p.itemKey];
    if (text) fields.fulltext = text;
    for (const k of Object.keys(fields)) if (!fields[k]) delete fields[k];
    return { id: p.itemKey, fields };
  });
}

/** Where a hit came from: the strongest field the query actually appears in. */
export function matchedFields(query: string, doc: Bm25Doc): string[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const out: { name: string; score: number }[] = [];
  for (const [name, text] of Object.entries(doc.fields)) {
    const low = text.toLocaleLowerCase();
    let hits = 0;
    for (const t of terms) if (low.includes(t)) hits++;
    if (hits) out.push({ name, score: hits * (KB_WEIGHTS[name] ?? 1) });
  }
  return out.sort((a, b) => b.score - a.score).map((x) => x.name);
}

/** A snippet centred on the first matched term, preferring the highest-weighted field. */
export function snippetFor(query: string, doc: Bm25Doc, radius = 150): string {
  const names = matchedFields(query, doc);
  const terms = queryTerms(query);
  for (const name of names.length ? names : Object.keys(doc.fields)) {
    const text = doc.fields[name] || "";
    const low = text.toLocaleLowerCase();
    let at = -1;
    let len = 0;
    for (const t of terms) {
      const i = low.indexOf(t);
      if (i >= 0 && (at === -1 || i < at)) {
        at = i;
        len = t.length;
      }
    }
    if (at < 0) continue;
    const from = Math.max(0, at - radius);
    const to = Math.min(text.length, at + len + radius * 2);
    return (from > 0 ? "…" : "") + text.slice(from, to).replace(/\s+/g, " ").trim() + (to < text.length ? "…" : "");
  }
  const first = Object.values(doc.fields)[0] || "";
  return first.slice(0, radius * 2).replace(/\s+/g, " ").trim();
}

/**
 * Text handed to the card writer: front matter, a couple of mid-document pages and the
 * tail, so method / dataset / metric sentences are represented without the whole paper.
 */
export function sampleForCard(pages: string[], budget = 9000): string {
  const clean = pages.map((p) => String(p || "").replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!clean.length) return "";
  const per = Math.max(600, Math.floor(budget / Math.min(clean.length, 6)));
  const idx = clean.length <= 6 ? clean.map((_, i) => i) : [0, 1, Math.floor(clean.length / 3), Math.floor(clean.length / 2), Math.floor((clean.length * 2) / 3), clean.length - 1];
  const seen = new Set<number>();
  const out: string[] = [];
  for (const i of idx) {
    if (seen.has(i)) continue;
    seen.add(i);
    out.push(`[p.${i + 1}] ${clean[i].slice(0, per)}`);
  }
  return out.join("\n\n").slice(0, budget);
}

/** Keep only printable, http(s) urls before putting an imported value into the DOM. */
export function safeUrl(raw: unknown): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : "";
  } catch {
    return "";
  }
}
