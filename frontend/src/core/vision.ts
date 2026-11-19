/**
 * Page rendering for the vision tool and 框图提问, plus vision-model helpers.
 * Rendering goes through core/reader.ts (pdf.js in the page) instead of the
 * desktop reader's hidden iframe.
 */
import type { ImageContent } from "@earendil-works/pi-ai";
import { completeText, getModel, listModels } from "./llm";
import { ensurePdf, getItem, paperKey, type Paper } from "./paper";
import { fractionToRect, getPageCount, getPageView, renderRegion, type RenderedImage } from "./reader";
import { refFromPaperKey, viewerState } from "./viewer-state";

export type RenderedRegion = RenderedImage;
export { fractionToRect };

/** Render a page (or a rect of it) of this paper to an image. */
export async function renderPaperRegion(
  item: Paper,
  pageIndex: number,
  rect?: number[] | null,
  maxSide = 1600,
): Promise<RenderedRegion> {
  if (!(await ensurePdf(item))) throw new Error("这篇文献没有可用的 PDF，无法查看页面图像");
  const key = paperKey({ libraryID: item.libraryID, itemKey: item.itemKey });
  const img = await renderRegion(key, pageIndex, rect, maxSide);
  return { ...img, pageLabel: String(pageIndex + 1) };
}

/** Same, but for the paper currently open in the reader (used by 框图提问). */
export async function renderActiveRegion(pageIndex: number, rect?: number[] | null, maxSide = 1600): Promise<RenderedRegion> {
  const key = viewerState.paperKey;
  if (!key) throw new Error("请先在左侧打开一篇文献");
  const item = getItem(refFromPaperKey(key));
  if (!item) throw new Error("当前文献不存在");
  return renderPaperRegion(item, pageIndex, rect, maxSide);
}

export function toImageContent(img: { data: string; mimeType: string }): ImageContent {
  return { type: "image", data: img.data, mimeType: img.mimeType };
}

export function modelSupportsImages(model: any): boolean {
  return Array.isArray(model?.input) && model.input.includes("image");
}

/** A configured model that accepts image input (prefers the quick model). */
export function visionModelId(preferred?: string): string | null {
  const candidates = [preferred, "deepseek-flash", ...listModels().map((m) => m.id)].filter(Boolean) as string[];
  for (const id of candidates) {
    if (modelSupportsImages(getModel(id))) return id;
  }
  return null;
}

/** Ask a vision model about an image and return its text answer (for text-only sessions). */
export async function describeImage(img: { data: string; mimeType: string }, question: string, signal?: AbortSignal): Promise<string> {
  const id = visionModelId();
  if (!id) throw new Error("没有可用的视觉模型（需要支持图片输入的模型）");
  return completeText(
    {
      systemPrompt:
        "You are a precise vision assistant for reading academic papers. Describe exactly what is visible (figures, axes, legends, trends, table cells, equations as LaTeX, text). Do not invent details that are not visible.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: question || "Describe this image from a paper in detail." }, toImageContent(img)],
          timestamp: Date.now(),
        },
      ],
    },
    { model: id, signal },
  );
}

export async function activePageCount(): Promise<number> {
  if (!viewerState.paperKey) return 0;
  return getPageCount(viewerState.paperKey);
}

export { getPageView };
