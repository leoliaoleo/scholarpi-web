/**
 * Vision: let the agent literally look at a page or a cropped figure.
 * Rendering happens in the page through pdf.js (core/reader.ts).
 */
import { Type } from "@earendil-works/pi-ai";
import { getAnnotation, type Annotation } from "../annotate";
import { getItem, paperKey } from "../paper";
import { refFromPaperKey } from "../viewer-state";
import {
  describeImage,
  fractionToRect,
  getPageView,
  modelSupportsImages,
  renderPaperRegion,
  toImageContent,
  type RenderedRegion,
} from "../vision";
import { ok, tool, type Tool, type ToolContext } from "./common";
import { resolvePaperItem } from "./paper-tools";

function imageOf(dataUrl: string, ann: Annotation): RenderedRegion {
  const comma = dataUrl.indexOf(",");
  const mimeType = /:(.*?);/.exec(dataUrl.slice(0, comma))?.[1] || "image/png";
  return {
    data: dataUrl.slice(comma + 1),
    mimeType,
    dataUrl,
    width: 0,
    height: 0,
    pageIndex: ann.pageIndex,
    pageLabel: ann.pageLabel,
    rect: ann.rects[0] || [0, 0, 0, 0],
    pageView: ann.viewBox,
  };
}

function annotationItem(ann: Annotation) {
  return getItem(refFromPaperKey(paperKey({ libraryID: ann.libraryID, itemKey: ann.itemKey })));
}

export function visionTools(ctx: ToolContext): Tool[] {
  const view = tool({
    name: "view_page_image",
    label: "查看页面图像",
    description:
      "Look at a rendered image of a PDF page or part of it — use it for figures, tables, equations, diagrams or layout that plain text cannot convey. Find the page first (e.g. paper_search 'Figure 3'). Optionally crop with `region` (fractions of the page, origin top-left), or view an image annotation by `annotation_key` (from get_annotations, type image). `question` says what to look for.",
    parameters: Type.Object({
      page: Type.Optional(Type.Number({ description: "1-based page number (not needed with annotation_key)" })),
      region: Type.Optional(
        Type.Object(
          {
            x: Type.Number({ description: "left, 0–1" }),
            y: Type.Number({ description: "top, 0–1" }),
            w: Type.Number({ description: "width, 0–1" }),
            h: Type.Number({ description: "height, 0–1" }),
          },
          { description: "Crop box as fractions of the page, e.g. top half = {x:0,y:0,w:1,h:0.5}" },
        ),
      ),
      annotation_key: Type.Optional(Type.String({ description: "Key of an image/area annotation to view" })),
      question: Type.Optional(Type.String({ description: "What you want to find out from the image" })),
      item_key: Type.Optional(Type.String({ description: "Other paper's key; omit for current paper" })),
    }),
    executionMode: "sequential",
    async execute(_id, p, signal) {
      let img: RenderedRegion;
      if (p.annotation_key) {
        const ann = await getAnnotation(p.annotation_key);
        if (!ann) throw new Error(`找不到批注 ${p.annotation_key}`);
        if (ann.imageData) {
          img = imageOf(ann.imageData, ann);
        } else {
          const item = annotationItem(ann);
          if (!item) throw new Error("批注所属文献不在当前工作区");
          img = await renderPaperRegion(item, ann.pageIndex, ann.rects[0] || null);
        }
      } else {
        if (typeof p.page !== "number") throw new Error("需要提供 page（1 起始）或 annotation_key");
        const item = resolvePaperItem(ctx, p.item_key);
        const key = paperKey({ libraryID: item.libraryID, itemKey: item.itemKey });
        const pageIndex = p.page - 1;
        const rect = p.region ? fractionToRect(await getPageView(key, pageIndex), p.region) : null;
        img = await renderPaperRegion(item, pageIndex, rect);
      }
      const cropped = !p.annotation_key && !!p.region;
      const what = `${p.annotation_key ? `annotation ${p.annotation_key}, ` : ""}page ${img.pageLabel}${cropped ? " (cropped)" : ""}${
        img.width ? `, ${img.width}×${img.height}px` : ""
      }`;
      if (modelSupportsImages(ctx.currentModel())) {
        return {
          content: [{ type: "text", text: `Rendered image of ${what}:` }, toImageContent(img)],
          details: { page: img.pageLabel, width: img.width, height: img.height },
        };
      }
      // Text-only model: let a vision model look and report back.
      const description = await describeImage(img, p.question || "Describe this region of the paper in detail.", signal);
      return ok(`[Your model cannot see images; a vision model looked at ${what} and reports:]\n\n${description}`, {
        page: img.pageLabel,
        described: true,
      });
    },
  });
  return [view];
}
