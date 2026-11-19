/**
 * 科研 Skills 工具箱 — the four one-click procedures, mounted above the composer.
 *
 * A skill gathers its deterministic data in `core/skills.ts` and returns a prompt; sending
 * it goes through the same `runtime.send()` the composer uses, so streaming, `[p. 5]` chips,
 * 划词/框图 and annotations all keep working. 文献侦察兵 additionally returns the candidates
 * it collected, which 一键入库 feeds straight into the library.
 */
import { useCallback, useEffect, useState } from "preact/hooks";
import type { SkillCandidate, SkillId, SkillMeta, SkillRun } from "../core/skills";
import { clearSkillRun } from "../core/skills";
import type { Collection, ImportResult } from "../core/library";
import { getApi, subscribe } from "./api";

const api = getApi();

const GROUP_LABEL: Record<SkillCandidate["group"], string> = {
  foundation: "奠基工作",
  followup: "后续跟进",
  related: "主题相近",
};

export function SkillBox({
  ctx,
  runtime,
  busy,
  onSend,
  notify,
}: {
  ctx: any;
  runtime: any;
  busy: boolean;
  onSend: (text: string) => void;
  notify: (text: string) => void;
}) {
  const [skills] = useState<SkillMeta[]>(() => api.skills.list());
  const [run, setRun] = useState<SkillRun | null>(() => api.skills.last());
  const [pending, setPending] = useState<SkillId | "">("");
  const [topic, setTopic] = useState("");
  const [showTopic, setShowTopic] = useState(false);
  const [error, setError] = useState("");

  const start = useCallback(
    async (id: SkillId, query = "") => {
      const meta = skills.find((s) => s.id === id);
      if (!meta || !ctx?.ref) return;
      if (busy) {
        notify("当前回答还没结束：先停止生成，或等它完成再运行技能");
        return;
      }
      const selected = api.selection.get();
      if (meta.needs === "papers" && selected.length < 2) {
        notify("先在左侧文献列表勾选 2–5 篇，再运行对比矩阵");
        return;
      }
      setError("");
      setPending(id);
      try {
        const out = await api.skills.run(id, { itemKey: ctx.ref.itemKey, itemKeys: selected, query });
        api.selection.clear();
        onSend(out.prompt);
        if (out.note) notify(`${out.icon} ${out.label}：${out.note}`);
      } catch (e: any) {
        setError(String(e?.message || e));
      } finally {
        setPending("");
        setShowTopic(false);
      }
    },
    [ctx?.ref?.itemKey, busy, onSend, notify, skills],
  );

  // the run is announced by core/skills, so the rail's 对比矩阵 button needs no extra plumbing
  useEffect(() => {
    const off = subscribe(api.events, (e: any) => {
      if (e.type === "skill-run") {
        setRun(api.skills.last());
        return;
      }
      if (e.type === "run-skill") void start(String(e.skill) as SkillId);
    });
    return off;
  }, [start]);

  if (!runtime) return null;

  const click = (meta: SkillMeta) => {
    if (meta.needs === "topic") setShowTopic(true);
    else void start(meta.id);
  };

  return (
    <div class="skill-box">
      <div class="skill-head">
        <span class="skill-title">🧪 科研 Skills 工具箱</span>
        <span class="muted small">技能会先自己抓数据，再把结构化任务交给 Pi</span>
      </div>
      <div class="skill-chips">
        {skills.map((s) => (
          <button
            class="skill-chip"
            key={s.id}
            disabled={!!pending}
            title={s.hint}
            onClick={() => click(s)}
          >
            <b>
              {s.icon} {s.label}
            </b>
            <span>{pending === s.id ? "正在准备…" : s.desc}</span>
          </button>
        ))}
      </div>
      {showTopic && (
        <form
          class="skill-topic"
          onSubmit={(e) => {
            e.preventDefault();
            void start("gap", topic.trim());
          }}
        >
          <input
            autoFocus
            value={topic}
            placeholder="研究方向（留空则分析整个知识库），如「高效微调」"
            onInput={(e) => setTopic((e.target as HTMLInputElement).value)}
          />
          <button class="primary" type="submit" disabled={!!pending}>
            开始挖掘
          </button>
          <button type="button" class="icon-btn" title="取消" onClick={() => setShowTopic(false)}>
            ×
          </button>
        </form>
      )}
      {error && <div class="error-box">{error}</div>}
      {!!run?.candidates.length && <CandidatePanel run={run} onClose={() => setRun(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// candidates the scout collected

function CandidatePanel({ run, onClose }: { run: SkillRun; onClose: () => void }) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [target, setTarget] = useState("");
  const [rows, setRows] = useState<ImportResult[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.kb.collections().then(setCollections).catch(() => undefined);
  }, [run.createdAt]);

  const todo = run.candidates.filter((c) => c.identifier && !c.inLibrary);
  const groups: SkillCandidate["group"][] = ["foundation", "followup", "related"];

  const grab = async () => {
    setBusy(true);
    try {
      setRows(await api.skills.grab(run.candidates, { collectionId: target || undefined }));
    } catch (e: any) {
      setRows([{ input: String(e?.message || e), ok: false, itemKey: "", title: "", action: "failed", pdf: false, note: "导入失败" }]);
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    if (api.skills.last() === run) clearSkillRun();
    onClose();
  };

  return (
    <div class="skill-cand">
      <div class="skill-cand-head">
        <b>
          {run.icon} {run.label} · 推荐 {run.candidates.length} 篇
        </b>
        <span class="muted small">{run.paperTitle ? `种子：${run.paperTitle.slice(0, 22)}` : ""}</span>
        <button class="icon-btn" title="收起" onClick={dismiss}>
          ×
        </button>
      </div>
      <div class="skill-cand-body">
        {groups
          .filter((g) => run.candidates.some((c) => c.group === g))
          .map((g) => (
            <div class="skill-group" key={g}>
              <div class="group-title">{GROUP_LABEL[g]}</div>
              {run.candidates
                .filter((c) => c.group === g)
                .map((c, i) => (
                  <div class={c.inLibrary ? "cand in" : "cand"} key={`${c.identifier || c.title}-${i}`}>
                    <span class="cand-title" title={c.title}>
                      {c.title}
                    </span>
                    <span class="cand-meta">
                      {[c.year, c.venue, c.citations ? `被引 ${c.citations}` : "", c.identifier || "无 arXiv/DOI"].filter(Boolean).join(" · ")}
                    </span>
                    {c.why && <span class="cand-why">{c.why}</span>}
                  </div>
                ))}
            </div>
          ))}
      </div>
      <div class="skill-cand-foot">
        <select value={target} onChange={(e) => setTarget((e.target as HTMLSelectElement).value)} title="导入后归入专题">
          <option value="">不归入专题</option>
          {collections.map((c) => (
            <option value={c.id}>{c.name}</option>
          ))}
        </select>
        <button class="primary" onClick={() => void grab()} disabled={busy || !todo.length}>
          {busy ? <span class="spinner" /> : "⇓"} 一键入库{todo.length ? ` (${todo.length})` : ""}
        </button>
      </div>
      {!!rows.length && (
        <div class="kb-import-log">
          {rows.map((r, i) => (
            <div class={r.ok ? "line ok" : "line err"} key={`${r.input}-${i}`}>
              <b>{r.ok ? (r.action === "existing" ? "已有" : "✓") : "✕"}</b>
              <span>{r.ok ? r.title || r.input : `${r.input}：${r.note}`}</span>
            </div>
          ))}
        </div>
      )}
      <div class="muted small">{todo.length ? "已入库的条目不会重复抓取；导入后可在左侧直接打开精读。" : "推荐清单里的论文都已经在知识库中了。"}</div>
    </div>
  );
}
