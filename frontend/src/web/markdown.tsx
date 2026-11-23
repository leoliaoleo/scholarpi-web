import katex from "katex";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { hydrateMermaid } from "./mermaid";
import { createMarkdown } from "../shared/markdown";

const cache = new Map<string, string>();

const md = createMarkdown((tex, display) => {
  const key = (display ? "D" : "I") + tex;
  let html = cache.get(key);
  if (html === undefined) {
    try {
      html = katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: "ignore", trust: false, output: "htmlAndMathml" });
    } catch {
      html = `<code>${md.utils.escapeHtml(tex)}</code>`;
    }
    if (cache.size > 2000) cache.clear();
    cache.set(key, html);
  }
  return display ? `<div class="math-display">${html}</div>` : html;
});

// Open links outside, mark page links
const defaultLinkOpen = md.renderer.rules.link_open || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = String(tokens[idx].attrGet("href") || "");
  if (/^page:/i.test(href)) tokens[idx].attrJoin("class", "page-link");
  else if (/^annotation:/i.test(href)) tokens[idx].attrJoin("class", "ann-link");
  else tokens[idx].attrSet("title", href);
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// ```mermaid fences → placeholder hydrated into a diagram after render
const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const t = tokens[idx];
  if (t.info.trim().toLowerCase() === "mermaid") {
    const code = md.utils.escapeHtml(t.content.trim());
    return `<div class="mermaid-block" data-code="${code}"><pre class="mermaid-src"><code>${code}</code></pre></div>\n`;
  }
  return defaultFence(tokens, idx, options, env, self);
};

/**
 * 六列的对比表塞进右栏就是每个字挤成一行：外层给它自己的横向滚动和一个展开入口。
 * 按钮不带 id，靠最近的 `.md-table` 找到同一张表，渲染出的 HTML 仍是 markdown-it 的产物
 * （原始 HTML 全程关闭），展开层只是把它换个宽度再画一次。
 */
md.renderer.rules.table_open = () =>
  '<div class="md-table"><div class="md-table-bar"><button type="button" class="md-table-zoom" title="展开宽屏阅读这张表">⤢ 展开宽屏阅读</button></div><div class="md-table-scroll"><table>';
md.renderer.rules.table_close = () => "</table></div></div>\n";

export function renderMarkdown(text: string): string {
  return md.render(text || "");
}

export function Markdown({ text, className, live = false }: { text: string; className?: string; live?: boolean }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const ref = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (ref.current && html.includes("mermaid-block")) hydrateMermaid(ref.current, live);
  }, [html, live]);
  // 正文变了，展开层里那张旧表就该跟着换掉（或直接关掉），不能让人读到过期的对比。
  useLayoutEffect(() => setWide(null), [html]);
  useEffect(() => {
    if (wide === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setWide(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wide]);
  const onClick = useCallback((e: MouseEvent) => {
    const btn = (e.target as HTMLElement).closest?.("button.md-table-zoom");
    if (!btn) return;
    const table = btn.closest(".md-table")?.querySelector("table");
    if (table) setWide(table.outerHTML);
  }, []);
  return (
    <>
      <div ref={ref} class={"md " + (className || "")} onClick={onClick as any} dangerouslySetInnerHTML={{ __html: html }} />
      {wide !== null && (
        <div class="modal md-table-modal" onMouseDown={(e) => e.target === e.currentTarget && setWide(null)}>
          <div class="md-table-card">
            <div class="md-table-head">
              <span class="muted small">宽屏阅读 · ESC 或点空白处关闭</span>
              <button class="modal-close" aria-label="关闭宽屏阅读" onClick={() => setWide(null)}>
                ×
              </button>
            </div>
            <div class="md md-table-wide" dangerouslySetInnerHTML={{ __html: wide }} />
          </div>
        </div>
      )}
    </>
  );
}
