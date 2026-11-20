/**
 * Knowledge-base helpers: tags, BM25 ranking, BibTeX, backup validation, identifier
 * parsing. Pure module on purpose — these run under `node --test` without IndexedDB or a DOM.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKUP_KIND,
  arxivStableId,
  bm25,
  buildKbDocs,
  identifierKind,
  inspectBackup,
  joinTags,
  matchedFields,
  normalizeTag,
  parseIdentifiers,
  planImports,
  safeUrl,
  snippetFor,
  splitTags,
  stripPaperForBackup,
  toBibtex,
  toBibtexLibrary,
  bibtexKey,
  tokenize,
} from "../frontend/src/core/library-util.ts";

test("tags normalise, split and join", () => {
  assert.equal(normalizeTag("  深度学习 / Transformer  "), "深度学习 · Transformer");
  assert.deepEqual(splitTags("CV,  transformer ,CV；NLP"), ["CV", "transformer", "NLP"]);
  assert.deepEqual(splitTags(["a", "A", "b"]), ["a", "b"]);
  assert.equal(joinTags(["a", "a", "b"]), "a, b");
  assert.deepEqual(splitTags(""), []);
});

test("tokenize covers latin words and CJK bigrams", () => {
  assert.deepEqual(tokenize("ResNet 残差网络"), ["resnet", "残差", "差网", "网络"]);
  assert.deepEqual(tokenize(""), []);
});

test("bm25 ranks a title hit above an abstract hit", () => {
  const docs = [
    { id: "a", fields: { title: "Deep Residual Learning for Image Recognition", abstract: "we use batch norm" } },
    { id: "b", fields: { title: "A survey of optimization", abstract: "mentions residual connections once" } },
  ];
  const ranked = bm25("residual learning", docs, { weights: { title: 4, abstract: 1 } });
  assert.equal(ranked[0].id, "a");
  assert.ok(ranked[0].score > ranked[1].score);
  assert.deepEqual(bm25("", docs), []);
  assert.deepEqual(bm25("quantum tunnelling", docs), []);
});

test("bm25 prefers the document matching every distinctive term", () => {
  const docs = [
    { id: "two", fields: { text: "attention mechanism" } },
    { id: "one", fields: { text: "attention is all you need for attention" } },
  ];
  const ranked = bm25("attention mechanism", docs, { weights: { text: 1 } });
  assert.equal(ranked[0].id, "two");
});

test("buildKbDocs falls back from card fields to the paper record", () => {
  const papers = [
    { itemKey: "1", title: "Scaling Laws", authors: "Kaplan", year: "2020", abstract: "neural nets scale", tags: "LLM" },
    { itemKey: "2", title: "Untitled upload", tags: "" },
  ];
  const cards = [{ itemKey: "1", method: "幂律拟合", summary: "算力换精度", tags: "经典" }];
  const docs = buildKbDocs(papers, cards, { "2": "a long paragraph about residual networks" });
  const d1 = docs.find((d) => d.id === "1")!;
  assert.equal(d1.fields.method, "幂律拟合");
  assert.equal(d1.fields.abstract, "neural nets scale");
  assert.equal(d1.fields.tags, "LLM, 经典");
  const d2 = docs.find((d) => d.id === "2")!;
  assert.equal(d2.fields.fulltext, "a long paragraph about residual networks");
  assert.ok(!("method" in d2.fields));
  assert.deepEqual(buildKbDocs([]), []);
});

test("matchedFields and snippetFor explain a hit", () => {
  const docs = buildKbDocs(
    [{ itemKey: "1", title: "BERT", abstract: "We introduce BERT, a bidirectional encoder." }],
    [{ itemKey: "1", method: "masked language model 预训练" }],
  );
  assert.deepEqual(matchedFields("masked language model", docs[0]), ["method"]);
  const snip = snippetFor("bidirectional", docs[0]);
  assert.ok(snip.toLowerCase().includes("bidirectional"));
  assert.ok(snip.length < 400);
});

test("bibtex keys stay unique and cite by surname-year-word", () => {
  const taken = new Set<string>();
  const a = bibtexKey({ title: "Deep Residual Learning", authors: "Kaiming He, Xiangyu Zhang", year: "2015" }, taken);
  taken.add(a);
  const b = bibtexKey({ title: "Deep Residual Learning", authors: "Kaiming He", year: "2015" }, taken);
  assert.equal(a, "he2015deep");
  assert.notEqual(a, b);
  assert.match(b, /^he2015deep./);
});

test("bibtex entries: article with journal, misc with eprint", () => {
  const entry = {
    itemKey: "1",
    title: "Deep Residual Learning for Image Recognition",
    authors: "Kaiming He and Xiangyu Zhang",
    year: "2015",
    venue: "CVPR",
    DOI: "10.1109/CVPR.2016.90",
    url: "https://doi.org/10.1109/CVPR.2016.90",
    abstract: "  spaced   text ",
  };
  const out = toBibtex(entry, bibtexKey(entry));
  assert.match(out, /^@inproceedings\{he2015deep,/);
  assert.match(out, /booktitle\s*= \{CVPR\}/);
  assert.match(out, /abstract\s*= \{spaced text\}/);
  const arxiv = { ...entry, venue: "arXiv", DOI: "10.48550/arXiv.1512.03385", url: "https://arxiv.org/abs/1512.03385" };
  const misc = toBibtex(arxiv, "he2015a");
  assert.match(misc, /^@misc\{/);
  assert.match(misc, /eprint\s*=\s*\{?1512\.03385\}?/);
  assert.ok(!/booktitle/.test(misc));
  const lib = toBibtexLibrary([entry, arxiv]);
  assert.equal((lib.match(/^@/gm) || []).length, 2);
  assert.equal(toBibtexLibrary([]), "");
});

test("backup payload validation catches the shapes that would break import", () => {
  assert.deepEqual(inspectBackup({ kind: BACKUP_KIND, papers: [{ itemKey: "a", title: "A" }], collections: [], cards: [] }), []);
  assert.ok(inspectBackup(null).length > 0);
  assert.ok(inspectBackup({ papers: {} }).some((i) => i.path === "papers"));
  assert.ok(inspectBackup({ papers: [{}] }).some((i) => i.path === "papers[0].itemKey"));
  assert.ok(inspectBackup({ kind: "other", papers: [] }).some((i) => i.path === "kind"));
});

test("backup never embeds PDF bytes", () => {
  const stripped = stripPaperForBackup({ itemKey: "a", title: "A", tags: "x", bytes: new Uint8Array(4), blobs: [1] });
  assert.deepEqual(Object.keys(stripped).sort(), ["itemKey", "tags", "title"]);
});

test("identifiers are recognised for one-click import", () => {
  assert.equal(identifierKind("2001.08361"), "arxiv");
  assert.equal(identifierKind("arXiv:1706.03762v7"), "arxiv");
  assert.equal(identifierKind("https://arxiv.org/pdf/1512.03385.pdf"), "arxiv");
  assert.equal(identifierKind("10.1109/CVPR.2016.90"), "doi");
  assert.equal(identifierKind("https://doi.org/10.1109/CVPR.2016.90"), "doi");
  assert.equal(identifierKind("https://openreview.net/pdf?id=rJ4ux07FwH"), "url");
});

test("pasted blocks split into unique identifiers", () => {
  const list = parseIdentifiers("2001.08361, 1706.03762;\n“10.1109/CVPR.2016.90” https://arxiv.org/abs/2005.14165 2001.08361");
  assert.deepEqual(list, ["2001.08361", "1706.03762", "10.1109/CVPR.2016.90", "https://arxiv.org/abs/2005.14165"]);
  assert.equal(parseIdentifiers("").length, 0);
  assert.equal(parseIdentifiers(Array.from({ length: 400 }, (_, i) => `1706.0${(i + 1000).toString().slice(0, 4)}`).join(" ")).length, 200);
});

test("arXiv ids collapse to the stable form the library keys on", () => {
  assert.equal(arxivStableId("1706.03762v5"), "1706.03762");
  assert.equal(arxivStableId("https://arxiv.org/pdf/2005.14165.pdf"), "2005.14165");
  assert.equal(arxivStableId("arXiv:2103.00020"), "2103.00020");
  assert.equal(arxivStableId("cs.CL/0307001v2"), "cs.CL/0307001");
});

test("a pasted batch splits into one arXiv request plus a concurrent remainder", () => {
  const plan = planImports(["1706.03762", "https://arxiv.org/abs/2005.14165v4", "10.1109/CVPR.2016.90", " ", "https://openreview.net/pdf?id=HK"]);
  assert.deepEqual(plan.arxiv.map((j) => j.i), [0, 1]);
  assert.deepEqual(plan.rest.map((j) => j.raw), ["10.1109/CVPR.2016.90", "https://openreview.net/pdf?id=HK"]);
  assert.deepEqual(plan.blanks.map((j) => j.i), [3]);
});

test("safeUrl rejects javascript: and non-urls", () => {
  assert.equal(safeUrl("javascript:alert(1)"), "");
  assert.equal(safeUrl("https://arxiv.org/abs/2001.08361"), "https://arxiv.org/abs/2001.08361");
  assert.equal(safeUrl("   "), "");
});
