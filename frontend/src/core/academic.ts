/**
 * arXiv (API + HTML full text), Google Scholar (with Semantic Scholar fallback) and the
 * identifier resolution the knowledge base imports papers through.
 */
import { identifierKind } from "./library-util";
import { domToText, httpGet, parseHTML } from "./web";

export interface ArxivEntry {
  id: string;
  title: string;
  authors: string[];
  published: string;
  updated: string;
  categories: string[];
  summary: string;
  pdf: string;
  abs: string;
}

export function normalizeArxivId(input: string): string {
  const s = input.trim();
  const m =
    s.match(/arxiv\.org\/(?:abs|pdf|html)\/([^?#\s]+?)(?:\.pdf)?(?:[?#].*)?$/i) ||
    s.match(/^(?:arxiv:)?\s*(\d{4}\.\d{4,5}(?:v\d+)?)$/i) ||
    s.match(/^(?:arxiv:)?\s*([a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)$/i);
  return m ? m[1] : s;
}

function text(el: Element | null | undefined): string {
  return (el?.textContent || "").replace(/\s+/g, " ").trim();
}

function parseAtom(xml: string): ArxivEntry[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  return Array.from(doc.getElementsByTagName("entry")).map((e) => {
    const absUrl = text(e.getElementsByTagName("id")[0]);
    const links = Array.from(e.getElementsByTagName("link"));
    return {
      id: absUrl.replace(/^https?:\/\/arxiv\.org\/abs\//, ""),
      title: text(e.getElementsByTagName("title")[0]),
      authors: Array.from(e.getElementsByTagName("author")).map((a) => text(a.getElementsByTagName("name")[0])),
      published: text(e.getElementsByTagName("published")[0]).slice(0, 10),
      updated: text(e.getElementsByTagName("updated")[0]).slice(0, 10),
      categories: Array.from(e.getElementsByTagName("category")).map((c) => c.getAttribute("term") || ""),
      summary: text(e.getElementsByTagName("summary")[0]),
      pdf: links.find((l) => l.getAttribute("title") === "pdf")?.getAttribute("href") || "",
      abs: absUrl,
    };
  });
}

export async function arxivSearch(
  query: string,
  opts: { max?: number; sortBy?: "relevance" | "submittedDate" | "lastUpdatedDate"; signal?: AbortSignal } = {},
): Promise<{ total: number; entries: ArxivEntry[] }> {
  // Allow raw arXiv query syntax (ti:, au:, abs:, cat:), otherwise search all fields.
  const q = /\b(ti|au|abs|cat|all|co|jr|id):/.test(query) ? query : `all:${query.trim().split(/\s+/).join(" AND all:")}`;
  const params = new URLSearchParams({
    search_query: q,
    start: "0",
    max_results: String(Math.min(opts.max || 8, 30)),
    sortBy: opts.sortBy || "relevance",
    sortOrder: "descending",
  });
  const res = await httpGet(`https://export.arxiv.org/api/query?${params}`, { signal: opts.signal });
  if (!res.ok) throw new Error(`arXiv API HTTP ${res.status}`);
  const xml = await res.text();
  const total = Number(xml.match(/<opensearch:totalResults[^>]*>(\d+)</)?.[1] || 0);
  return { total, entries: parseAtom(xml) };
}

export async function arxivGet(id: string, signal?: AbortSignal): Promise<ArxivEntry | null> {
  const res = await httpGet(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(normalizeArxivId(id))}`, { signal });
  if (!res.ok) throw new Error(`arXiv API HTTP ${res.status}`);
  const entries = parseAtom(await res.text());
  return entries.find((e) => e.title && e.title !== "Error") || null;
}

export interface ArxivSection {
  title: string;
  text: string;
}

const htmlCache = new Map<string, ArxivSection[] | null>();

/** Full text from arxiv.org/html/<id> split into top-level sections. */
export async function arxivSections(id: string, signal?: AbortSignal): Promise<ArxivSection[] | null> {
  const key = normalizeArxivId(id);
  if (htmlCache.has(key)) return htmlCache.get(key)!;
  const res = await httpGet(`https://arxiv.org/html/${key}`, { signal });
  if (!res.ok) {
    htmlCache.set(key, null);
    return null;
  }
  const doc = parseHTML(await res.text());
  const article = doc.querySelector("article.ltx_document") || doc.querySelector("article") || doc.body;
  if (!article) return null;
  const sections: ArxivSection[] = [];
  const abs = article.querySelector(".ltx_abstract");
  if (abs) sections.push({ title: "Abstract", text: domToText(abs, res.url, false).replace(/^#+\s*Abstract\s*/i, "") });
  const tops = Array.from(article.querySelectorAll(":scope > section, :scope > div > section")).filter(
    (s) => /ltx_(section|appendix|bibliography)/.test(s.className),
  );
  for (const sec of tops) {
    const h = sec.querySelector(".ltx_title");
    const title = text(h) || sec.id;
    sections.push({ title, text: domToText(sec, res.url, false) });
  }
  if (sections.length <= 1) sections.push({ title: "Full text", text: domToText(article, res.url, false) });
  htmlCache.set(key, sections);
  if (htmlCache.size > 20) htmlCache.delete(htmlCache.keys().next().value!);
  return sections;
}

// ---------------------------------------------------------------------------
// Google Scholar

export interface ScholarResult {
  title: string;
  url: string;
  authorsVenue: string;
  snippet: string;
  citedBy?: number;
  pdf?: string;
}

export async function scholarSearch(
  query: string,
  opts: { max?: number; yearFrom?: number; yearTo?: number; signal?: AbortSignal } = {},
): Promise<{ source: string; results: ScholarResult[]; note?: string }> {
  const params = new URLSearchParams({ hl: "en", q: query });
  if (opts.yearFrom) params.set("as_ylo", String(opts.yearFrom));
  if (opts.yearTo) params.set("as_yhi", String(opts.yearTo));
  let blocked = "";
  try {
    const res = await httpGet(`https://scholar.google.com/scholar?${params}`, { signal: opts.signal });
    const html = await res.text();
    if (res.ok && !/gs_captcha|unusual traffic|id="recaptcha"/i.test(html)) {
      const doc = parseHTML(html);
      const results: ScholarResult[] = [];
      for (const r of Array.from(doc.querySelectorAll(".gs_r.gs_or.gs_scl"))) {
        const a = r.querySelector(".gs_rt a");
        const titleEl = r.querySelector(".gs_rt");
        const cited = Array.from(r.querySelectorAll(".gs_fl a")).find((x) => /Cited by/.test(x.textContent || ""));
        results.push({
          title: text(a || titleEl).replace(/^\[(PDF|HTML|BOOK|CITATION|B)\]\s*/g, ""),
          url: a?.getAttribute("href") || "",
          authorsVenue: text(r.querySelector(".gs_a")),
          snippet: text(r.querySelector(".gs_rs")),
          citedBy: cited ? Number((cited.textContent || "").replace(/\D/g, "")) || undefined : undefined,
          pdf: r.querySelector(".gs_or_ggsm a")?.getAttribute("href") || undefined,
        });
        if (results.length >= (opts.max || 10)) break;
      }
      if (results.length) return { source: "google_scholar", results };
      blocked = "Google Scholar 没有返回结果";
    } else {
      blocked = `Google Scholar 拒绝了请求（HTTP ${res.status}，可能需要人机验证）`;
    }
  } catch (e: any) {
    if (opts.signal?.aborted) throw e;
    blocked = `Google Scholar 无法访问：${e.message}`;
  }
  // Fallback: Semantic Scholar Graph API
  const ss = new URLSearchParams({
    query,
    limit: String(opts.max || 10),
    fields: "title,authors,year,venue,abstract,citationCount,externalIds,url,openAccessPdf",
  });
  if (opts.yearFrom || opts.yearTo) ss.set("year", `${opts.yearFrom || ""}-${opts.yearTo || ""}`);
  const res = await httpGet(`https://api.semanticscholar.org/graph/v1/paper/search?${ss}`, { signal: opts.signal });
  if (!res.ok) throw new Error(`${blocked}；Semantic Scholar 回退也失败（HTTP ${res.status}）`);
  const data = await res.json();
  return {
    source: "semantic_scholar",
    note: `${blocked}，已改用 Semantic Scholar`,
    results: (data.data || []).map((p: any) => ({
      title: p.title,
      url: p.url || (p.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : ""),
      authorsVenue: `${(p.authors || []).slice(0, 5).map((a: any) => a.name).join(", ")} - ${p.venue || ""} ${p.year || ""}`.trim(),
      snippet: String(p.abstract || "").slice(0, 400),
      citedBy: p.citationCount,
      pdf: p.openAccessPdf?.url,
    })),
  };
}

// ---------------------------------------------------------------------------
// knowledge-base sources: Semantic Scholar records, Crossref DOIs, identifier resolution

const S2_FIELDS = "title,authors,year,venue,abstract,citationCount,referenceCount,externalIds,openAccessPdf,tldr";

function cleanDoi(raw: string): string {
  return String(raw || "")
    .trim()
    .replace(/^doi[:\s]+/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/[),.;\]]+$/, "");
}

/** One Semantic Scholar record, or null when the id is unknown or the API is throttled. */
export async function semanticPaper(id: string, signal?: AbortSignal): Promise<any | null> {
  try {
    const res = await httpGet(`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(id)}?fields=${S2_FIELDS}`, { signal });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.paperId ? data : null;
  } catch (e) {
    if (signal?.aborted) throw e;
    return null;
  }
}

/** Graph edges for 文献侦察兵: who cites a paper, and what that paper builds on. */
export async function semanticGraph(
  id: string,
  dir: "citations" | "references",
  opts: { limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<any[]> {
  const params = new URLSearchParams({
    fields: "title,authors,year,venue,citationCount,externalIds",
    limit: String(Math.min(opts.limit || 50, 500)),
  });
  if (opts.offset) params.set("offset", String(opts.offset));
  const res = await httpGet(`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(id)}/${dir}?${params}`, {
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`Semantic Scholar ${dir} HTTP ${res.status}`);
  const data = await res.json();
  return (data.data || []).map((row: any) => row.citingPaper || row.citedPaper || row).filter(Boolean);
}

export async function semanticSearch(query: string, opts: { limit?: number; year?: string; signal?: AbortSignal } = {}): Promise<any[]> {
  const params = new URLSearchParams({ query, limit: String(Math.min(opts.limit || 20, 100)), fields: S2_FIELDS });
  if (opts.year) params.set("year", opts.year);
  const res = await httpGet(`https://api.semanticscholar.org/graph/v1/paper/search?${params}`, { signal: opts.signal });
  if (!res.ok) throw new Error(`Semantic Scholar search HTTP ${res.status}`);
  const data = await res.json();
  return data.data || [];
}

export interface CrossrefRecord {
  title: string;
  authors: string[];
  year: string;
  venue: string;
  url: string;
  pdf: string;
}

export async function crossrefDoi(doi: string, signal?: AbortSignal): Promise<CrossrefRecord | null> {
  try {
    const res = await httpGet(`https://api.crossref.org/works/${encodeURIComponent(cleanDoi(doi))}`, { signal });
    if (!res.ok) return null;
    const m = (await res.json())?.message;
    if (!m) return null;
    const link = (m.link || []).find((l: any) => /application\/pdf/i.test(String(l["content-type"] || l.type || "")));
    const year = m.issued?.["date-parts"]?.[0]?.[0] || "";
    return {
      title: (m.title || [])[0] || "",
      authors: (m.author || []).map((a: any) => [a.given, a.family].filter(Boolean).join(" ") || a.name || "").filter(Boolean),
      year: String(year),
      venue: (m["container-title"] || [])[0] || "",
      url: m.URL || `https://doi.org/${cleanDoi(doi)}`,
      pdf: link?.URL || "",
    };
  } catch (e) {
    if (signal?.aborted) throw e;
    return null;
  }
}

/** Everything the knowledge base needs to file one paper, whatever the user pasted. */
export interface ExternalRecord {
  itemKey: string;
  title: string;
  authors: string;
  year: string;
  venue: string;
  DOI: string;
  url: string;
  pdfUrl: string;
  abstract: string;
  tags: string;
  kind: "arxiv" | "doi" | "url";
  hints: { tldr: string; keywords: string[]; citations: number; references: number };
}

function fromArxiv(e: ArxivEntry, id: string): ExternalRecord {
  const stable = id.replace(/v\d+$/i, "");
  return {
    itemKey: stable,
    title: e.title || `arXiv:${stable}`,
    authors: (e.authors || []).join(", "),
    year: (e.published || "").slice(0, 4),
    venue: "arXiv",
    DOI: `10.48550/arXiv.${stable}`,
    url: e.abs || `https://arxiv.org/abs/${stable}`,
    pdfUrl: e.pdf || `https://arxiv.org/pdf/${stable}`,
    abstract: e.summary || "",
    tags: ["arXiv", ...e.categories.slice(0, 1)].filter(Boolean).join(", "),
    kind: "arxiv",
    hints: { tldr: "", keywords: e.categories.slice(0, 5), citations: 0, references: 0 },
  };
}

function enrich(rec: ExternalRecord, s2: any): void {
  if (!s2) return;
  rec.hints.tldr = s2.tldr || rec.hints.tldr;
  rec.hints.citations = s2.citationCount || 0;
  rec.hints.references = s2.referenceCount || 0;
  const ext = s2.externalIds || {};
  if (ext.DOI && !rec.DOI) rec.DOI = String(ext.DOI);
  if (!rec.abstract && s2.abstract) rec.abstract = String(s2.abstract);
  if (!rec.venue && s2.venue) rec.venue = String(s2.venue);
  if (!rec.pdfUrl && /^https?:\/\//i.test(s2.openAccessPdf?.url || "")) rec.pdfUrl = s2.openAccessPdf.url;
}

/**
 * arXiv id / arXiv link / DOI / plain link → one library-ready record. A bare link keeps an
 * empty itemKey: the caller hashes it, because only the registry knows its own key format.
 */
export async function resolveExternal(value: string, signal?: AbortSignal): Promise<ExternalRecord> {
  const raw = String(value || "").trim();
  const kind = identifierKind(raw);
  if (kind === "arxiv") {
    const id = normalizeArxivId(raw);
    const entry = await arxivGet(id, signal);
    if (!entry) throw new Error(`arXiv 上找不到 ${id}`);
    const rec = fromArxiv(entry, id);
    enrich(rec, await semanticPaper(`ARXIV:${rec.itemKey}`, signal));
    return rec;
  }
  if (kind === "doi") {
    const doi = cleanDoi(raw);
    const arxivInDoi = doi.match(/^10\.48550\/arxiv\.(\d{4}\.\d{4,5})/i);
    if (arxivInDoi) {
      const rec = await resolveExternal(arxivInDoi[1], signal);
      rec.DOI = doi;
      return rec;
    }
    const [cr, s2] = await Promise.all([crossrefDoi(doi, signal), semanticPaper(`DOI:${doi}`, signal)]);
    if (!cr && !s2) throw new Error(`DOI ${doi} 没有返回元数据（Crossref 与 Semantic Scholar 都查不到）`);
    const pdf = (/^https?:\/\//i.test(s2?.openAccessPdf?.url || "") && s2.openAccessPdf.url) || cr?.pdf || "";
    return {
      itemKey: `doi:${doi}`,
      title: cr?.title || s2?.title || doi,
      authors: cr?.authors?.length ? cr.authors.join(", ") : (s2?.authors || []).map((a: any) => a.name).join(", "),
      year: String(cr?.year || s2?.year || ""),
      venue: cr?.venue || s2?.venue || "",
      DOI: doi,
      url: cr?.url || s2?.url || `https://doi.org/${doi}`,
      pdfUrl: /^https?:\/\//i.test(pdf) ? pdf : "",
      abstract: s2?.abstract || "",
      tags: "DOI",
      kind: "doi",
      hints: { tldr: s2?.tldr || "", keywords: [], citations: s2?.citationCount || 0, references: s2?.referenceCount || 0 },
    };
  }
  const looksPdf = /\.pdf(?:$|[?#])/i.test(raw) || /openreview\.net\/pdf\?id=/i.test(raw);
  return {
    itemKey: "",
    title: raw.replace(/^https?:\/\//, "").slice(0, 80),
    authors: "",
    year: "",
    venue: "",
    DOI: "",
    url: looksPdf ? "" : raw,
    pdfUrl: raw,
    abstract: "",
    tags: "链接添加",
    kind: "url",
    hints: { tldr: "", keywords: [], citations: 0, references: 0 },
  };
}
