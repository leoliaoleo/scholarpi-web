/**
 * 「文章脉络」面板：PDF 工具栏唤出的浮层卡，默认不出现，不占首屏。
 *
 * 树由 `core/outline.ts` 生成（引擎来自队友的 zotero-coread-ai），这里只做四件事：
 * 树边生成边长出来、点关键句跳到那一页并在 PDF 上圈出原句、把原句划成高亮批注、
 * 复制/导出脉络 Markdown。圈不到原句就照实说「只跳到了页」，不用高亮假装定位成功。
 */
import { useEffect, useState } from "preact/hooks";
import { createHighlight } from "../core/annotate";
import {
  cancelOutline,
  clearOutline,
  generateOutline,
  loadOutline,
  outlineChanges,
  outlineState,
  revealAnchor,
  type OutlineState,
} from "../core/outline";
import {
  RELATION_LABELS,
  flattenOutline,
  outlineToMarkdown,
  type OutlineAnchor,
  type OutlineNode,
  type PaperOutline,
} from "../core/outline-schema";
import type { Paper } from "../core/paper";
import { noteFileName } from "../shared/note";
import { subscribe } from "./api";
import { NoteActions, QuickError } from "./components";

const clip = (s: string, n = 46) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function OutlinePanel({
  paperKey,
  item,
  onClose,
  onNotice,
}: {
  /** `${libraryID}/${itemKey}`，与阅读器、`core/outline.ts` 同一个口径。 */
  paperKey: string;
  item: Paper;
  onClose: () => void;
  onNotice: (text: string, tone?: "warn" | "info") => void;
}) {
  const [st, setSt] = useState<OutlineState>(() => outlineState(paperKey));
  /** 折叠是本地视图状态：换论文时清空，别让上一篇的节点 id 影响这一篇。 */
  const [folded, setFolded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setSt(outlineState(paperKey));
    setFolded({});
    // 打开面板只读缓存，不发模型请求：生成要等读者自己点。
    void loadOutline(paperKey);
    return subscribe(outlineChanges, (e) => {
      if (e.key === paperKey) setSt(e.state);
    });
  }, [paperKey]);

  const tree: PaperOutline | undefined =
    st.status === "ready" ? st.outline : st.status === "loading" ? st.partial : undefined;

  const jump = async (a: OutlineAnchor) => {
    const r = await revealAnchor(paperKey, a);
    if (!r.ok) {
      onNotice(
        `已跳到第 ${r.page} 页，但这一页的文字层里没找到脉络引用的原句（扫描版或措辞被改写过）：请人工核对，别把跳转当成依据。`,
        "warn",
      );
    }
  };

  const mark = async (n: OutlineNode) => {
    const a = n.anchors.find((x) => x.quote);
    if (!a?.quote) return onNotice("这一条没有逐字原句，划不了重点：点页码只能跳到那一页。", "warn");
    try {
      const r = await createHighlight(item, { quote: a.quote, page: a.page, comment: `脉络 · ${n.title}` });
      onNotice(`已在第 ${r.pageIndex + 1} 页划出「${clip(n.title, 24)}」，批注里带着这条脉络。`, "info");
    } catch (e: any) {
      onNotice(`划重点失败：${String(e?.message || e)}`, "warn");
    }
  };

  const node = (n: OutlineNode, depth: number) => {
    const kids = n.children || [];
    const shut = !!folded[n.id];
    const quote = n.anchors.find((a) => a.quote);
    return (
      <div class={`ol-node depth-${Math.min(depth, 2)}`} key={n.id}>
        <div class="ol-node-head">
          {!!kids.length && (
            <button
              class="ol-fold"
              aria-label={shut ? "展开这一节的子条目" : "折叠这一节的子条目"}
              onClick={() => setFolded({ ...folded, [n.id]: !shut })}
            >
              {shut ? "▸" : "▾"}
            </button>
          )}
          <span class="ol-node-title">
            {n.title}
            {n.period ? <span class="muted"> · {n.period}</span> : null}
          </span>
          <span class="ol-acts">
            {n.anchors.map((a, i) => (
              <button
                key={i}
                class="chip ol-anchor"
                title={a.quote ? `原文（第 ${a.page} 页）：${a.quote}` : `${a.figure || "图表"} 在第 ${a.page} 页`}
                onClick={() => void jump(a)}
              >
                {a.figure ? a.figure : `p.${a.page}`}
              </button>
            ))}
            {!!quote && (
              <button class="chip ol-mark" title="把这条逐字原句划成高亮批注" onClick={() => void mark(n)}>
                划重点
              </button>
            )}
          </span>
        </div>
        {!!n.summary && <p class="ol-sum">{n.summary}</p>}
        {!shut && !!kids.length && <div class="ol-kids">{kids.map((c) => node(c, depth + 1))}</div>}
      </div>
    );
  };

  return (
    <div class="ol-panel" role="complementary" aria-label="文章脉络">
      <div class="ol-head">
        <b>文章脉络</b>
        {tree && <span class="ol-kind">{tree.kind === "survey" ? "综述" : "研究论文"}</span>}
        <div class="spacer" />
        {st.status === "ready" && (
          <button
            class="icon-btn"
            title="重新梳理一次（会再用一次演示额度）"
            aria-label="重新梳理脉络"
            onClick={() => generateOutline(paperKey, true)}
          >
            ⟳
          </button>
        )}
        <button class="icon-btn" title="收起脉络面板" aria-label="收起脉络面板" onClick={onClose}>
          ×
        </button>
      </div>

      <div class="ol-body">
        {st.status === "error" && (
          <div class="ol-block">
            {/* 请求没成功走既有的分类文案（额度/限速/超时各说各的），我们自己判定的失败照原话说。 */}
            {st.transport ? <QuickError error={st.message} /> : <p class="ol-error">{st.message}</p>}
            <button class="primary" onClick={() => generateOutline(paperKey, true)}>
              再试一次
            </button>
          </div>
        )}

        {st.status === "idle" && (
          <div class="ol-block">
            <p>把整篇论文梳成「摘要拆解 → 章节 → 关键句」：点每条关键句会跳到那一页，并在 PDF 上圈出它引用的原文。</p>
            <p class="muted small">
              这需要读全文，会用掉一次演示额度；梳理过的论文下次直接显示缓存，不再请求模型。脉络走极速非思考通道，节点一秒内就开始长出来。
            </p>
            <button class="primary" onClick={() => generateOutline(paperKey)}>
              梳一遍这篇的脉络
            </button>
          </div>
        )}

        {st.status === "loading" && (
          <div class="ol-block">
            <p class="ol-stage">
              <span class="spinner" /> {st.stage}
              <button class="chip" onClick={() => cancelOutline(paperKey)}>
                停止
              </button>
            </p>
            {!!st.thinking && (
              <details class="ol-think">
                <summary class="muted small">思考过程</summary>
                <div class="ol-think-body">{st.thinking}</div>
              </details>
            )}
            {!tree && <p class="muted small">脉络会一边生成一边长出来，先出来的章节现在就能点。</p>}
          </div>
        )}

        {tree && (
          <div class="ol-tree">
            {!!tree.oneLine && <p class="ol-one">{tree.oneLine}</p>}
            {tree.sections.map((s) => node(s, 0))}
            {!!tree.relations.length && (
              <div class="ol-rels">
                <b class="muted small">脉络关系</b>
                {tree.relations.map((r, i) => (
                  <p key={i} class="ol-rel">
                    {clip(titleOf(tree, r.from), 18)} → {RELATION_LABELS[r.type] || r.type} → {clip(titleOf(tree, r.to), 18)}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {st.status === "ready" && (
        <div class="ol-foot">
          <NoteActions
            label="文章脉络"
            copyLabel="复制脉络 Markdown"
            build={() => outlineToMarkdown(st.outline)}
            file={() => noteFileName({ title: item.title || "文献" }, "文章脉络")}
          />
          <button
            class="chip"
            title="删掉这篇的脉络缓存：只清本地缓存，不影响论文和批注"
            onClick={() => {
              void clearOutline(paperKey);
              onNotice("已清除这篇的脉络缓存，下次打开面板需要重新梳理。", "info");
            }}
          >
            清除缓存
          </button>
        </div>
      )}
    </div>
  );
}

const titleOf = (o: PaperOutline, id: string) => flattenOutline(o).find((f) => f.node.id === id)?.node.title || id;
