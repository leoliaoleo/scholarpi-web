# ScholarPi Web —— 科研文献智能体工作台

> 高校创造力大赛 · StudyHack 学习科研赛道参赛作品
>
> **在线体验（公开访问，无需登录、无需 Key）**：<https://scholarpi-web-tpzo6tda9by.qoder.zone/>

为组会读英文论文：抓住贡献，点击结论核验原文，带走阅读笔记。

---

## 60 秒核心体验

| 时间 | 你看到什么 | 背后发生了什么 |
| --- | --- | --- |
| 0–5 秒 | 打开就是示例精读入口，点「体验示例精读」 | Attention Is All You Need 的 PDF 走本站静态资源，**不发起任何模型请求** |
| 5–20 秒 | 右侧已经有一份《核心贡献与结论》：范式、公式、结果、局限，每条后面挂着 `[p. 3]` 这样的页码芯片 | 精读报告与页码证据随站打包（`backend/data/demo_papers/`），首次访问零等待 |
| 20–35 秒 | 点任意一个 `[p. 3]` | 左侧 PDF 跳到该页并**逐字高亮这句话的原文**；如果没能精确匹配，阅读器会明说「已跳转至第 x 页，未精确匹配到原句高亮」，不会把跳页成功伪装成核验成功 |
| 35–50 秒 | 在输入框问「这套位置编码和 ResNet 的残差有什么关系？」 | Agent 调用 `paper_overview / paper_search / paper_read` 渐进式读原文后作答，回答里的每个页码都可以点回去 |
| 50–60 秒 | 点「复制 Markdown」或「下载笔记 .md」 | 导出内容自带标题、来源、年份、arXiv 标识、导出日期与 `[p. N]` 页码，可直接粘进 Notion / Obsidian / LaTeX |

想再多看一会儿：左下角「🕸 知识图谱」看论文—方法—数据集的关系网，「📊 多篇横向对比矩阵」把勾选的 2–5 篇拉成一张表，右下角的蓝发小鲸鱼「Pi 科研小助手」会带你走完这 5 步。

---

## 亮点

### 证据可点回去，且诚实标注边界

- `[p. x]` 芯片 = 论文 PDF 的物理页码，点击跳页并高亮原句；跳页与匹配是两件事，系统分开说。
- 扫描件 / 无文字层 PDF 会明确告诉你「无法逐字定位原文」，Agent 侧同时被禁止编造页码引用（`paper_read` / `paper_search` 直接返回不可绕过的警告）。
- 对比矩阵结尾强制附「⚠️ 可比性说明」：不同论文的任务、数据集与评价协议不一样，表里的数字不是同条件对比。
- Research Gap 的输出标题就是「候选研究方向及核验建议」，每个选题都要分开写「已由文献核实的前提」与「仍需查证的部分」。
- 知识图谱顶部标注每个节点的来源：预置示例（人工整理）／自动提取（元数据卡片生成，可能不完整）。

### 数据留在你自己的设备上

专题、标签、元数据卡片、批注、上传的 PDF 全部存在浏览器 IndexedDB；换设备用「备份 → 导出 JSON」搬运（BibTeX 可直接进 LaTeX / Zotero）。**PDF 只在你在调用 AI 时把你选中的文本或截图发出去**，不做整篇上传、不做服务端留存。

### 双轨制密钥，演示额度可共享而不泄漏

- **BYOK**：自己的 DeepSeek Key 只写进本机 `localStorage`，请求直连你的账户。
- **免 Key 体验**：Key 只存在于服务端 Secret（`DEEPSEEK_API_KEY`），由 Function 代理注入，**任何响应都不会把它回显给浏览器**；按访客维度限流（默认 6 次/分钟、120 次/小时、600 次/天），超额时前端给出可执行的下一步（先看示例 / 填自己的 Key / 稍后重试），而不是一个 429。

### 秒级批量导入

元数据与 PDF 下载解耦：arXiv 元数据用一次 `id_list=` 批量请求拿回，PDF 在后台并发（上限 4，单篇 8 秒超时）下载并逐篇回报进度。导入 4–5 篇从过去的 175–218 秒降到秒级返回，PDF 慢不挡列表出现。

### 首屏做减法

左栏只留搜索框、文献列表和常驻的「上传 PDF / 批量导入」；备份、MCP 服务、模型与思考强度收纳进「⋯ 更多」；专题默认折叠，标签默认一行 +「展开全部」；语义扩展默认关闭——普通检索走本地关键词匹配，不额外消耗演示额度。

---

## 真实性能边界（不吹）

- **首屏 JS 约 1.8 MB**（pdf.js + d3-force + Agent 运行时，未做代码分割），静态资源走边缘节点缓存，二次访问命中缓存后接近即时。
- **示例 PDF 是真实体积**：Attention 2.2 MB、ResNet 0.8 MB、BERT 0.8 MB。第一次点开需要把这份字节下完，之后进内存缓存，同一会话内来回切换不重复下载。
- **精读报告首次访问是预置内容**，不是模型现场生成的——这是为了 0 等待，页面上标注了「示例精读 · 预置内容」，导出笔记里也带同一句说明。你自己的论文走真实 Agent 链路。
- **演示额度是共享的**：繁忙时会排队限流，此时填入自己的 Key 即可恢复速度。
- **扫描版 PDF 不能核验原文**：没有文字层就没有逐字定位，也没有可靠的页码引用，只能先 OCR 或换文字版。
- **划词与框图提问依赖 pdf.js 的文本层与渲染**：极端排版（多栏 + 旋转页）下高亮框可能有偏差，跳页本身准确。

---

## 架构

```
frontend/            Preact 10 + TypeScript，esbuild 打包（无框架运行时）
  src/core/          Agent 运行时、论文/PDF、知识库(IndexedDB)、MCP、Skills、图谱
  src/web/           工作台壳层：文献栏 · pdf.js 阅读器 · Pi 会话 · 设置 · 桌宠
  src/shared/        DOM-free 纯模块（markdown / errors / layout / note），可被 node --test 直接断言
  src/styles/        设计变量由 Qoder Sites 外观系统驱动（--site-space / --site-type …）
functions/           Qoder Sites Edge Function（Deno）：llm 代理 / arXiv 中继 / 搜索 / MCP 桥 / 限流
backend/app.py       本地开发用的等价 Flask 后端（同一套路由，便于离线调试）
test/                node:test 回归锁（纯模块行为 + 关键文案）
```

- 模型侧使用 `@earendil-works/pi-agent-core`：工具表 = 论文工具 + 知识库工具 + Skills + 内置学术 MCP 桥（`arxiv_search` / `semantic_scholar_citations` / `fetch_paper_pdf`）+ 用户自备 MCP 服务。
- 所有对第三方学术站点的请求经 Function 白名单中继发出，绕开 arXiv 等站点缺失的 CORS 头；线上只允许公网 https 端点。

---

## 本地运行

```bash
npm ci
npm run build                 # 产出 frontend/dist
python backend/app.py         # http://127.0.0.1:5000
```

**需要配置环境变量（免 Key 体验依赖它）**：`backend/app.py` 读 `DEEPSEEK_API_KEY` 作为服务端演示 Key。没有这个变量时，本地页面仍可用，但只有填入自己 Key 的访客能调用模型，左上角状态灯会显示「需填入自己的 Key」。

```bash
# Windows PowerShell
$env:DEEPSEEK_API_KEY = "sk-..."   ; python backend/app.py
# macOS / Linux
DEEPSEEK_API_KEY=sk-... python backend/app.py
```

其余可选变量（都有默认值，不改也能跑）：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 上游 LLM 地址 |
| `PORT` / `HOST` | `5000` / `127.0.0.1` | 本地服务监听 |
| `SCHOLARPI_DIST` | `../frontend/dist` | 静态目录 |
| `DEMO_LIMIT_PER_MIN` / `_HOUR` / `_DAY` | `6` / `120` / `600` | 演示额度限流 |
| `RELAY_MAX_BYTES` | `8 MB` | arXiv PDF 中继上限 |

本地调试可以同时访问 `127.0.0.1` 上的自建 MCP / SearXNG 服务；线上 Function 不允许。

## 部署到 Qoder Sites

1. `npm run build`
2. 站点静态目录 = `frontend/dist`，Function 目录 = `functions`
3. **必须配置 Secret `DEEPSEEK_API_KEY`**（Sites → 该站点 → Backend / Secrets），否则免 Key 访客会立即碰到「需填入自己的 Key」；BYOK 访客不受影响。
4. 如需调整额度，在 Secrets/环境变量里设置 `DEMO_LIMIT_PER_MIN`、`DEMO_LIMIT_PER_HOUR`、`DEMO_LIMIT_PER_DAY`。
5. 访问权限设为公开，发布后在公网验证：状态灯为绿、示例秒开可跳页、批量导入返回速度、图谱往返正常。

---

## 验证

```bash
npx tsc --noEmit   # 类型
npm test           # node:test 回归（纯模块 + 关键文案，70 用例）
npm run build      # 打包
```

测试刻意锁住几条容易被后来改动破坏的承诺：导出的笔记里不残留 `page:` 内部路由；预置示例自动标注「示例精读 · 预置内容」；缺字段时不编字段；跳页失败必须说「未精确匹配」；无文字层 PDF 必须禁止页码引用；对比矩阵与 Research Gap 的输出必须带边界说明。

---

## 说明

- 示例论文（Attention / ResNet / BERT）的原文 PDF 与已解析文本来自 arXiv 公开版本，仅用于课程演示；精读解读为本站人工整理。
- 本项目由 [zotero-pi](https://github.com/sdyzjx/zotero-pi-agent) 桌面插件重构而来：去掉 Zotero 宿主耦合，把 SQLite/Zotero 存储换成 IndexedDB，把 Flask 后端换成 Edge Function，前端换成 Preact + pdf.js 自绘工作台。
