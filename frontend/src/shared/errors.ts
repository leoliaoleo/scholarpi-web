/**
 * One place that turns a raw transport error into the short, honest sentence the
 * visitor sees. Pure on purpose: the same strings are asserted by `node --test`.
 *
 * The server already says which window closed (`每分钟 6 次` / `每天 600 次`) and
 * how long to wait, so the UI never invents a queue position or a countdown.
 */

export type ErrorKind = "rate" | "quota" | "timeout" | "pdf" | "auth" | "network" | "unknown";

export interface Classified {
  kind: ErrorKind;
  /** One sentence, no jargon, no blame. */
  message: string;
  /** Only when the server told us a trustworthy number of seconds. */
  retryAfter?: number;
  /** Raw server text, kept for the expandable details line. */
  detail: string;
  actions: ErrorAction[];
}

export type ErrorAction = "example" | "retry" | "key";

const RATE_COPY = "演示请求较多，已保留你的问题。你可以先查看示例，稍后重试。";
const QUOTA_COPY = "演示额度这一轮已用完，稍后会自动恢复。想立刻继续，可在设置里填入自己的 Key。";
const TIMEOUT_COPY = "这次请求超时了，草稿与已有精读报告都还在，可以再发一次。";
const PDF_COPY = "PDF 没能在预期时间内传完，页面位置已保留；网络拥塞时重试或换原文链接更快。";
const PDF_DENIED_COPY = "这篇论文的 PDF 无法直接下载（服务器拒绝了请求，通常需要登录或订阅）。可点「打开原文链接」或直接把 PDF 拖进来。";
const AUTH_COPY = "演示 Key 未开启或已失效，填入自己的 DeepSeek Key 即可继续。";
const NETWORK_COPY = "网络连接中断，输入内容已保留，可以重试。";

/** Seconds, but only if the source looks trustworthy (finite, 1s…2h). */
export function usableRetryAfter(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(Math.round(n), 7200);
}

function jsonField(text: string, field: string): string {
  const m = new RegExp(`"${field}"\\s*:\\s*(?:"([^"]*)"|(\\d+))`).exec(text);
  return m ? (m[1] ?? m[2]) : "";
}

export function classifyError(raw: unknown, opts: { status?: number; retryAfter?: unknown; pdf?: boolean } = {}): Classified {
  const text = String(raw ?? "");
  const loose = text.toLowerCase();
  const detail = text.replace(/\s+/g, " ").trim().slice(0, 240);
  const bodyError = jsonField(text, "error");
  const seconds = usableRetryAfter(opts.retryAfter) ?? usableRetryAfter(jsonField(text, "retryAfter"));

  if (opts.pdf || /pdf|下载超时|加载失败/.test(loose)) {
    const denied = opts.status === 401 || opts.status === 403 || /401|403|forbidden|denied|未授权|拒绝|登录|订阅/.test(loose);
    return denied
      ? { kind: "pdf", message: PDF_DENIED_COPY, detail, actions: ["retry", "example"] }
      : { kind: "pdf", message: PDF_COPY, detail, actions: ["retry", "example"] };
  }
  const is429 = opts.status === 429 || bodyError === "rate_limited" || /\b429\b/.test(text) || /rate.?limit/.test(loose);
  if (is429) {
    const daily = /每天|daily|used.?up/i.test(text);
    return daily
      ? { kind: "quota", message: QUOTA_COPY, detail, retryAfter: seconds, actions: ["example", "key", "retry"] }
      : { kind: "rate", message: RATE_COPY, detail, retryAfter: seconds, actions: ["example", "retry", "key"] };
  }
  if (/额度|quota|已用完/.test(text)) {
    return { kind: "quota", message: QUOTA_COPY, detail, retryAfter: seconds, actions: ["example", "key", "retry"] };
  }
  if (/timeout|超时|abort|stall/.test(loose)) {
    return { kind: "timeout", message: TIMEOUT_COPY, detail, retryAfter: seconds, actions: ["retry", "example"] };
  }
  if (opts.status === 401 || bodyError === "missing_demo_key" || /api.?key|未授权|401|forbidden|403/.test(loose)) {
    return { kind: "auth", message: AUTH_COPY, detail, actions: ["key", "retry"] };
  }
  if (/failed to fetch|network|err_|dns|连接/.test(loose)) {
    return { kind: "network", message: NETWORK_COPY, detail, actions: ["retry"] };
  }
  return { kind: "unknown", message: detail ? `这次请求没有成功：${detail.slice(0, 80)}` : "这次请求没有成功，内容都已保留。", detail, actions: ["retry", "example"] };
}

/** Only used when the server actually gave us seconds. */
export function retryLabel(seconds?: number): string {
  if (!seconds) return "";
  if (seconds < 60) return `约 ${seconds} 秒后可以再试`;
  if (seconds < 3600) return `约 ${Math.ceil(seconds / 60)} 分钟后可以再试`;
  return `约 ${Math.ceil(seconds / 3600)} 小时后可以再试`;
}

/**
 * Pages but zero characters means a scan, which is a different problem from "no
 * attachment at all": telling them apart is what stops the agent from citing a
 * page number it never read.
 */
export function textLayerNotice(pages: number, chars: number): string {
  if (chars > 0) return "";
  if (pages > 0) {
    return `警告：这份 PDF 有 ${pages} 页，但提取到 0 个字符（很可能是扫描件或图片版）。没有可核验的原文，因此禁止输出任何 [p. x] 页码引用；请基于摘要与元数据作答，并说明原文无法逐字核验，建议先 OCR 或改用文字版 PDF。`;
  }
  return "警告：这篇文献没有可读取的全文（只有摘要或元数据）。禁止输出任何 [p. x] 页码引用；请说明结论依据仅限摘要与元数据。";
}

/**
 * The status line next to the π mark. Kept deliberately non-committal: the shared
 * key exists, but its budget is a guard rail, not a promise.
 */
export function statusLabel(health: { ok?: boolean; demoKey?: boolean } | null, ownKey: boolean): { text: string; tone: "ok" | "warn" | "off" } {
  if (!health) return { text: "正在连接服务…", tone: "warn" };
  if (!health.ok) return { text: "服务器未连接", tone: "off" };
  if (ownKey) return { text: "个人 Key 已配置", tone: "ok" };
  return health.demoKey ? { text: "演示模式可用", tone: "ok" } : { text: "需填入自己的 Key", tone: "warn" };
}
