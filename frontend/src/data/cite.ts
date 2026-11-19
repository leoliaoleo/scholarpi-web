/**
 * Citation chip used by the preset readings: `[p. 12](page:12?q=…)`.
 *
 * `quote` must be copied verbatim from the page. The locator is tolerant about
 * case, whitespace, hyphens-at-line-break and quote glyphs, but it does not
 * paraphrase — a reworded quote still jumps to the page yet cannot be outlined.
 */
export function cite(page: number, quote: string): string {
  const encoded = encodeURIComponent(quote.trim()).replace(/[()!*']/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `[p. ${page}](page:${page}?q=${encoded})`;
}
