import { useState } from "preact/hooks";
import type { McpServerConfig, McpServerState } from "../core/mcp";
import { clone, getApi } from "./api";

const api = getApi();

const THINKING: [string, string][] = [
  ["off", "关闭思考"],
  ["low", "低"],
  ["high", "高（默认）"],
  ["max", "最大"],
];

function Field({ label, hint, children }: { label: string; hint?: string; children: any }) {
  return (
    <label class="field">
      <span class="label">{label}</span>
      <div class="control">
        {children}
        {hint && <div class="hint">{hint}</div>}
      </div>
    </label>
  );
}

export function SettingsPanel() {
  const [s, setS] = useState<any>(() => clone(api.getSettings()));
  const [models, setModels] = useState<any[]>(() => clone(api.listModels()));
  const [showKey, setShowKey] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [remote, setRemote] = useState<string[]>([]);
  const set = (k: string, v: any) => setS((prev: any) => ({ ...prev, [k]: v }));

  const save = () => {
    api.saveSettings(s);
    setModels(clone(api.listModels()));
    setStatus({ ok: true, text: "已保存" });
    setTimeout(() => setStatus(null), 2500);
  };

  const test = async () => {
    api.saveSettings(s);
    setTesting(true);
    setStatus(null);
    try {
      const r = clone(await api.testConnection());
      setStatus({ ok: r.ok, text: r.message });
      setRemote(r.remoteModels || []);
    } finally {
      setTesting(false);
    }
  };

  const addExtra = (id: string) => {
    const list = s.extraModels.split(/[,\s]+/).filter(Boolean);
    if (!list.includes(id) && !models.some((m) => m.id === id)) set("extraModels", [...list, id].join(", "));
  };

  const actions: any[] = s.quickActions;
  const setAction = (i: number, patch: any) => set("quickActions", actions.map((a, j) => (i === j ? { ...a, ...patch } : a)));

  return (
    <div class="page">
      <header>
        <div class="logo">π</div>
        <div>
          <h1>ScholarPi 设置</h1>
          <div class="sub">浏览器端科研文献智能体 · ScholarPi Web v{api.version}</div>
        </div>
      </header>

      <section>
        <h2>模型与 API</h2>
        <Field label="DeepSeek API Key" hint="留空则使用服务端演示 Key（Qoder Sites Secret：DEEPSEEK_API_KEY，有次数限制）；填写后仅保存在本浏览器 localStorage。获取：platform.deepseek.com">
          <div class="row">
            <input type={showKey ? "text" : "password"} value={s.apiKey} placeholder="sk-..." onInput={(e) => set("apiKey", (e.target as HTMLInputElement).value.trim())} />
            <button onClick={() => setShowKey(!showKey)}>{showKey ? "隐藏" : "显示"}</button>
          </div>
        </Field>
        <Field label="API 地址" hint="默认走服务端代理 /functions/v1/app/llm，密钥不落前端；也可填 https://api.deepseek.com 直连">
          <input value={s.baseUrl} onInput={(e) => set("baseUrl", (e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="默认对话模型">
          <select value={s.model} onChange={(e) => set("model", (e.target as HTMLSelectElement).value)}>
            {models.map((m) => (
              <option value={m.id}>
                {m.name} ({m.id})
              </option>
            ))}
          </select>
        </Field>
        <Field label="默认思考强度" hint="新会话使用；每个会话可在输入框下方单独切换">
          <select value={s.thinkingLevel} onChange={(e) => set("thinkingLevel", (e.target as HTMLSelectElement).value)}>
            {THINKING.map(([v, l]) => (
              <option value={v}>{l}</option>
            ))}
          </select>
        </Field>
        <Field label="翻译 / 结论模型" hint="用于划词翻译与自动生成会话结论（不开启思考，速度优先）">
          <select value={s.quickModel} onChange={(e) => set("quickModel", (e.target as HTMLSelectElement).value)}>
            {models.map((m) => (
              <option value={m.id}>{m.name}</option>
            ))}
          </select>
        </Field>
        <Field label="额外模型 ID" hint="逗号分隔，用于 DeepSeek 新发布、pi 尚未内置的模型">
          <input value={s.extraModels} placeholder="例如 deepseek-v4-flash" onInput={(e) => set("extraModels", (e.target as HTMLInputElement).value)} />
        </Field>
        <div class="row actions">
          <button class="primary" onClick={test} disabled={testing}>
            {testing ? "测试中…" : "测试连接"}
          </button>
          {remote.length > 0 && (
            <span class="remote">
              账户可用模型：
              {remote.map((id) => (
                <button class="tag" title="加入额外模型" onClick={() => addExtra(id)}>
                  {id}
                </button>
              ))}
            </span>
          )}
        </div>
      </section>

      <section>
        <h2>阅读与回答</h2>
        <Field label="回答语言">
          <input value={s.replyLanguage} onInput={(e) => set("replyLanguage", (e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="翻译目标语言">
          <input value={s.targetLanguage} onInput={(e) => set("targetLanguage", (e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="单次读取字符上限" hint="渐进式披露：Agent 每次读取论文 / 网页的最大字符数（1000–50000）">
          <input type="number" min={1000} max={50000} step={1000} value={s.maxReadChars} onInput={(e) => set("maxReadChars", Number((e.target as HTMLInputElement).value))} />
        </Field>
        <Field label="自动生成会话结论" hint="每轮对话结束后用快速模型总结结论，供其他文章的会话查阅">
          <input type="checkbox" checked={s.autoConclusion} onChange={(e) => set("autoConclusion", (e.target as HTMLInputElement).checked)} />
        </Field>
        <Field label="自定义系统提示词" hint="追加到 Agent 的系统提示词末尾">
          <textarea rows={4} value={s.customSystemPrompt} onInput={(e) => set("customSystemPrompt", (e.target as HTMLTextAreaElement).value)} />
        </Field>
      </section>

      <section>
        <h2>网络搜索</h2>
        <Field label="搜索引擎" hint="DeepSeek 搜索使用同一个 API Key，按次计费（约 $0.75 / 千次成功请求）；失败时自动回退到 DuckDuckGo">
          <select value={s.searchEngine} onChange={(e) => set("searchEngine", (e.target as HTMLSelectElement).value)}>
            <option value="deepseek">DeepSeek 搜索（推荐）</option>
            <option value="duckduckgo">DuckDuckGo（免费）</option>
            <option value="tavily">Tavily</option>
            <option value="brave">Brave Search</option>
            <option value="searxng">SearXNG（自建）</option>
          </select>
        </Field>
        {s.searchEngine === "tavily" && (
          <Field label="Tavily API Key">
            <input type="password" value={s.tavilyKey} onInput={(e) => set("tavilyKey", (e.target as HTMLInputElement).value.trim())} />
          </Field>
        )}
        {s.searchEngine === "brave" && (
          <Field label="Brave API Key">
            <input type="password" value={s.braveKey} onInput={(e) => set("braveKey", (e.target as HTMLInputElement).value.trim())} />
          </Field>
        )}
        {s.searchEngine === "searxng" && (
          <Field label="SearXNG 地址">
            <input value={s.searxngUrl} placeholder="https://searx.example.com" onInput={(e) => set("searxngUrl", (e.target as HTMLInputElement).value.trim())} />
          </Field>
        )}
        <Field label="网页读取" hint="DeepSeek Fetch 返回整理后的 Markdown（按次计费）；本地抓取免费但对动态网页效果较差">
          <select value={s.fetchEngine} onChange={(e) => set("fetchEngine", (e.target as HTMLSelectElement).value)}>
            <option value="deepseek">DeepSeek Fetch（失败时回退本地）</option>
            <option value="local">本地抓取</option>
          </select>
        </Field>
      </section>

      <section>
        <h2>批注</h2>
        <Field label="AI 批注颜色">
          <input type="color" value={s.annotationColor} onInput={(e) => set("annotationColor", (e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="AI 批注标签" hint="AI 创建的批注会加上此标签，便于筛选（留空则不加）">
          <input value={s.annotationTag} onInput={(e) => set("annotationTag", (e.target as HTMLInputElement).value)} />
        </Field>
      </section>

      <section>
        <h2>划词操作</h2>
        <div class="hint">选中 PDF 文本后弹出的 AI 按钮。提示词中的 {"{text}"} 会被替换为选中文本；“翻译”类型使用快速模型直接翻译。</div>
        {actions.map((a, i) => (
          <div class="action">
            <input class="a-label" value={a.label} onInput={(e) => setAction(i, { label: (e.target as HTMLInputElement).value })} />
            <select value={a.mode} onChange={(e) => setAction(i, { mode: (e.target as HTMLSelectElement).value })}>
              <option value="agent">Agent</option>
              <option value="translate">翻译</option>
            </select>
            <textarea rows={2} disabled={a.mode === "translate"} value={a.prompt} placeholder={a.mode === "translate" ? "（翻译无需提示词）" : "提示词，包含 {text}"} onInput={(e) => setAction(i, { prompt: (e.target as HTMLTextAreaElement).value })} />
            <button onClick={() => set("quickActions", actions.filter((_, j) => j !== i))}>删除</button>
          </div>
        ))}
        <div class="row">
          <button onClick={() => set("quickActions", [...actions, { id: `custom${Date.now()}`, label: "新操作", mode: "agent", prompt: "{text}" }])}>添加操作</button>
        </div>
      </section>

      <section>
        <h2>个人知识库</h2>
        <Field label="检索时启用语义扩展" hint="全局检索先让模型把提问扩成中英文关键词，再一起打分；关闭后只做关键词匹配（不消耗 Key，速度更快）">
          <input type="checkbox" checked={s.kbSemantic} onChange={(e) => set("kbSemantic", (e.target as HTMLInputElement).checked)} />
        </Field>
        <Field label="导入后自动生成元数据卡片" hint="每导入一篇调用一次模型，填写「核心方法 / 数据集 / 关键指标 / 一句话总结」；关闭后可在卡片里随时点「让模型生成」">
          <input type="checkbox" checked={s.kbAutoCard} onChange={(e) => set("kbAutoCard", (e.target as HTMLInputElement).checked)} />
        </Field>
        <div class="hint">
          专题、标签、元数据卡片、批注与上传的 PDF 全部存在本浏览器的 IndexedDB 中，不会上传；换设备时用左侧「备份 → 导出 JSON」搬运（BibTeX 可直接进 LaTeX / Zotero）。
        </div>
      </section>

      <McpSection s={s} set={set} />

      <footer>
        {status && <span class={status.ok ? "ok" : "err"}>{status.text}</span>}
        <button class="primary" onClick={save}>
          保存
        </button>
      </footer>
    </div>
  );
}


// ---------------------------------------------------------------------------
// MCP

interface McpRow {
  id: string;
  label: string;
  url: string;
  transport: "http" | "sse";
  headersText: string;
  enabled: boolean;
}

function toRow(cfg: McpServerConfig): McpRow {
  return {
    id: cfg.id,
    label: cfg.label === cfg.id ? "" : cfg.label,
    url: cfg.url,
    transport: cfg.transport === "sse" ? "sse" : "http",
    headersText: Object.entries(cfg.headers || {})
      .map(([k, v]) => `${k}: ${v}`)
      .join("; "),
    enabled: cfg.enabled,
  };
}

function fromRow(row: McpRow, i: number): Partial<McpServerConfig> & { id: string } {
  const headers: Record<string, string> = {};
  for (const part of row.headersText.split(/[;\n]+/)) {
    const kv = part.match(/^\s*([^:\s][^:]*?)\s*:\s*(.+?)\s*$/);
    if (kv) headers[kv[1]] = kv[2];
  }
  return {
    id: row.id.trim() || `mcp${i + 1}`,
    label: row.label.trim() || row.id.trim() || `MCP ${i + 1}`,
    url: row.url.trim(),
    transport: row.transport,
    headers,
    enabled: row.enabled,
  };
}

function McpSection({ s, set }: { s: any; set: (k: string, v: any) => void }) {
  const [rows, setRows] = useState<McpRow[]>(() => api.mcp.parse(s.mcpServers).map(toRow));
  const [states, setStates] = useState<McpServerState[]>(() => clone(api.mcp.states()));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const write = (next: McpRow[]) => {
    setRows(next);
    set("mcpServers", JSON.stringify(next.map(fromRow)));
  };
  const patch = (i: number, p: Partial<McpRow>) => write(rows.map((r, j) => (i === j ? { ...r, ...p } : r)));

  const probe = async () => {
    setBusy(true);
    setNote(null);
    try {
      // apply() persists first, so a row that was only just typed is the one being tested
      const r = clone(await api.mcp.apply(s));
      setStates(r.servers);
      setNote({
        ok: r.servers.every((x: McpServerState) => x.status !== "error"),
        text: `已发现 ${r.toolCount} 个 MCP 工具：${r.servers.map((x: McpServerState) => `${x.label} ${x.status === "ready" ? "✓" : "✕"}`).join("，")}`,
      });
    } catch (e: any) {
      setNote({ ok: false, text: String(e?.message || e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>MCP 服务配置</h2>
      <Field label="内置学术桥接器" hint="默认开启：arxiv_search（论文检索）、semantic_scholar_citations（引用关系）、fetch_paper_pdf（PDF 直链）三个工具，经服务端白名单代理调用，无需任何 Key">
        <input type="checkbox" checked={s.mcpBridge} onChange={(e) => set("mcpBridge", (e.target as HTMLInputElement).checked)} />
      </Field>
      {s.mcpBridge && (
        <div class="mcp-tools">
          {api.mcp
            .builtinTools()
            .map((t: any) => (
              <div class="mcp-tool" key={t.name} title={t.description}>
                <code>academic__{t.name}</code>
                <span class="muted small">{String(t.description || "").split(/[。.!！]/)[0]}</span>
              </div>
            ))}
        </div>
      )}

      <div class="hint">
        接入自己的 MCP 服务（任何提供 Streamable HTTP 或旧版 SSE 端点的服务器），Pi 会把它的工具列进同一份工具表，工具名形如{" "}
        <code>服务名__工具名</code>。请求由后端 <code>/app/mcp</code> 代理发出：线上站点只允许公网 https 端点，本地 <code>python backend/app.py</code> 可同时访问 127.0.0.1 的服务。
      </div>

      {rows.map((r, i) => (
        <div class="mcp-row" key={i}>
          <label class="mcp-toggle" title="启用/停用">
            <input type="checkbox" checked={r.enabled} onChange={(e) => patch(i, { enabled: (e.target as HTMLInputElement).checked })} />
          </label>
          <input class="mcp-id" value={r.id} placeholder="标识，如 mylab" onInput={(e) => patch(i, { id: (e.target as HTMLInputElement).value })} />
          <input value={r.label} placeholder="显示名（可选）" onInput={(e) => patch(i, { label: (e.target as HTMLInputElement).value })} />
          <select value={r.transport} onChange={(e) => patch(i, { transport: (e.target as HTMLSelectElement).value as "http" | "sse" })}>
            <option value="http">Streamable HTTP</option>
            <option value="sse">SSE</option>
          </select>
          <input class="mcp-url" value={r.url} placeholder="https://mcp.example.com/mcp" onInput={(e) => patch(i, { url: (e.target as HTMLInputElement).value })} />
          <input class="mcp-headers" value={r.headersText} placeholder="请求头：Authorization: Bearer xxx（多个用 ; 分隔）" onInput={(e) => patch(i, { headersText: (e.target as HTMLInputElement).value })} />
          <button onClick={() => write(rows.filter((_, j) => j !== i))}>删除</button>
        </div>
      ))}
      <div class="row">
        <button onClick={() => write([...rows, { id: "", label: "", url: "", transport: "http", headersText: "", enabled: true }])}>添加 MCP 服务</button>
        <button class="primary" onClick={() => void probe()} disabled={busy}>
          {busy ? "连接中…" : "连接并测试"}
        </button>
        {note && <span class={note.ok ? "ok" : "err"}>{note.text}</span>}
      </div>

      {!!states.filter((x) => x.transport !== "builtin").length && (
        <div class="mcp-tools">
          {states
            .filter((x) => x.transport !== "builtin")
            .map((x) => (
              <div class={x.status === "ready" ? "mcp-tool ok" : "mcp-tool err"} key={x.id} title={x.error || x.url}>
                <code>
                  {x.label} · {x.status === "ready" ? `${x.tools.length} 个工具` : "连接失败"}
                </code>
                <span class="muted small">{x.status === "ready" ? x.tools.map((t) => t.name).join(", ") : x.error}</span>
              </div>
            ))}
        </div>
      )}
      <div class="hint">
        直接编辑配置也可以：把 JSON 数组写进 <code>localStorage.scholarpi.mcpServers</code>，形如{" "}
        <code>{'[{"id":"mylab","url":"https://mcp.example.com/mcp","transport":"http","headers":{"Authorization":"Bearer ..."}}]'}</code>。密钥只存在这台浏览器的本地设置里。
      </div>
    </section>
  );
}
