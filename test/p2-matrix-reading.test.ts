/**
 * 跨篇对比的阅读体验与首页预览定位（第二轮微调的回归锁）。
 *
 * 这一轮全是「看得懂、点得动」的细节，改起来往往只是一行渲染或一句提示词，所以除了纯字符串
 * 函数直接调用，其余按源码断言（沿用仓库既有办法：UI 组件带浏览器依赖，Node 直跑不了）。
 * 三条底线：表格里不许漏 `<br>` 源码；跨篇芯片必须带着自己那篇的 item_key，点错了比点不动更坏；
 * 从首页预览点进来时右侧要停在被点的那条结论上，而不是五千字报告的末尾。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { createMarkdown } from "../frontend/src/shared/markdown.ts";
import { pageChips, plainCitations, plainLine } from "../frontend/src/shared/note.ts";
import { skillDigest } from "../frontend/src/shared/skillprompt.ts";

const source = (rel: string) => readFileSync(new URL(`../frontend/src/${rel}`, import.meta.url), "utf8");
const md = createMarkdown((tex: string, display: boolean) => `[${display ? "D" : "I"}:${tex}]`);

// ---------------------------------------------------------------- 1 <br> 与表格

test("表格里的 <br> 渲染成真实换行，其它原始 HTML 仍旧只是文本", () => {
  for (const tag of ["<br>", "<br/>", "<br />", "<BR>"]) {
    const out = md.render(`| 甲${tag}乙 | 丙 |\n|---|---|\n| 1 | 2 |`);
    assert.ok(out.includes("<br>"), `${tag} 要变成真的换行，实际：${out}`);
    assert.ok(!out.includes("&lt;br"), `${tag} 不该以源码形式留在页面上`);
  }
  // 只认这一个换行标签：模型 echo 回来的 web 内容仍然不能变成可执行标记。
  assert.match(md.render("<img src=x onerror=alert(1)>"), /&lt;img/);
  assert.doesNotMatch(md.render("[x](javascript:alert(1))"), /href=/, "危险协议不因为改了 <br> 就变成链接");
});

test("对比表给横向滚动与展开入口：容器、最小列宽、宽屏层都在", () => {
  const renderer = source("web/markdown.tsx");
  assert.match(renderer, /md\.renderer\.rules\.table_open[\s\S]*md-table-scroll/, "表格要包在自己的横向滚动容器里");
  assert.match(renderer, /class="md-table-zoom"[^>]*>⤢ 展开宽屏阅读/);
  assert.match(renderer, /md\.renderer\.rules\.table_close = \(\) => "<\/table><\/div><\/div>\\n"/, "开闭标签得配对，滚动层和按钮都在同一张表的壳里");
  assert.match(renderer, /const \[wide, setWide\] = useState<string \| null>\(null\)/);
  assert.match(renderer, /btn\.closest\("\.md-table"\)\?\.querySelector\("table"\)/, "展开的是这张表本身，不是全文");
  assert.match(renderer, /if \(e\.key === "Escape"\) setWide\(null\)/, "ESC 要关得掉");
  assert.match(renderer, /e\.target === e\.currentTarget && setWide\(null\)/, "点遮罩也要关得掉");
  assert.match(renderer, /useLayoutEffect\(\(\) => setWide\(null\), \[html\]\)/, "正文变了，展开层里不该还留着旧表");

  const css = source("styles/chat.css");
  assert.match(css, /\.md-table-scroll \{ overflow-x: auto; \}/);
  assert.match(css, /\.md th:first-child, \.md td:first-child \{ min-width: 140px; \}/, "首列至少 140px");
  assert.match(css, /\.md td \{ min-width: 160px; \}/, "数据列至少 160px");
  assert.doesNotMatch(css, /\.md table \{[^}]*display: block/, "display:block 会让六列没有列宽概念，只能挤成一行");
});

// ---------------------------------------------------------------- 2 跨篇芯片绑定论文

test("芯片带 k=<item_key>：页码、原句、论文标识一起解析出来", () => {
  const line = "算力换精度 [Transformer · p. 2](page:2?q=Attention%20is%20all%20you%20need&k=1706.03762) 与 [BERT · p. 4](page:4?q=pre-training%20objectives&k=1810.04805)";
  const chips = pageChips(line);
  assert.equal(chips.length, 2, "两个芯片都要认出来");
  assert.deepEqual(chips.map((c) => [c.page, c.key]), [[2, "1706.03762"], [4, "1810.04805"]]);
  assert.match(chips[0].quote, /^Attention is all you need$/, "q= 解码后就是原句，别把 &k=… 一起吃进去");
  // 单篇报告的老写法（不带 k）照旧可用。
  assert.deepEqual(pageChips("[p. 3](page:3?q=a%20b)").map((c) => [c.page, c.quote, c.key]), [[3, "a b", undefined]]);

  const out = plainCitations(line);
  assert.ok(!out.includes("page:"), "导出笔记里不留应用内路由");
  assert.equal(out.split("[Transformer · p. 2]").length - 1, 1, "标签里已经写了页码，就不该再补一个 [p. 2]");
  assert.ok(!/\[Transformer · p\. 2\] \[p\. 2\]/.test(out), out);
  // 标签没写页码时，页码仍要留在正文里。
  assert.match(plainCitations("[这段原话](page:9?q=a&k=K)"), /这段原话 \[p\. 9\]/);
  assert.match(plainLine(line), /Transformer · p\. 2/);
});

test("点击芯片按 k 换 PDF；换不了、没全文、对不上句都要说出来", () => {
  const chat = source("web/chat.tsx");
  assert.match(chat, /\(\?:\\\?q=\(\[\^&\]\*\)\)\?\(\?:&k=\(\[\^&\]\*\)\)\?/, "href 里要拆得出 q 和 k");
  assert.match(chat, /api\.openPage\(chipKey\(a, m\[3\], ref\), Number\(m\[1\]\), quoteOf\(m\[2\]\)\)/, "带 k 就点那一篇，不带才退回当前会话");
  assert.match(chat, /const first = a\.closest\("tr"\)\?\.children\?\.\[0\]\?\.textContent/, "缺 k= 时先按所在行的首列再认一次论文");
  assert.match(chat, /return hits\.size === 1 \? \[\.\.\.hits\]\[0\] : ref;/, "一行里认不出唯一一篇就不猜，退回后由 openPage 说清楚");

  const api = source("web/api.ts");
  assert.match(api, /没有可用的 PDF 全文，第 \$\{page\} 页无法定位/, "只有链接没有 PDF 时要说清该怎么做");
  assert.match(api, /item\.source === "demo" \|\| item\.source === "upload" \|\| !!item\.pdfUrl/, "有没有全文的口径要和跨篇对比跳过文献时一致");
  assert.match(api, /已切换到《\$\{paperTitle\(item\)\}》第 \$\{page\} 页/, "换了论文要让读者知道现在看的是哪一篇");
  assert.match(api, /已切换至《\$\{paperTitle\(item\)\}》：/, "换了论文又没匹配上原句：两件事都要说");
  assert.match(api, /请手动核验该页原文/);
  assert.match(api, /不在知识库里，第 \$\{page\} 页无法跳转/, "k 指向一篇已删除的文献也不能静默");
  assert.match(api, /已跳转至第 \$\{page\} 页，未精确匹配到原句高亮/, "上一轮那句话不许被改掉");
});

// ---------------------------------------------------------------- 3 提示词折叠与口径

test("技能工单默认收成一句人话，展开才看到发给模型的原文", () => {
  const matrix = "【科研技能 · 跨篇对比】对比下面 3 篇文献。\n\n### [1] Attention Is All You Need\n…很长的工单…";
  const d = skillDigest(matrix);
  assert.equal(d?.label, "对比这 3 篇论文");
  assert.equal(d?.detail, matrix, "展开显示的必须是逐字原文，一个字都不改");
  assert.equal(skillDigest("【科研技能 · 跨篇对比】对比下面 2 篇文献。")?.label, "对比这 2 篇论文");
  assert.equal(skillDigest("【科研技能 · 找相关论文】以《BERT》（item_key=1810.04805）为种子论文做文献侦察。")?.label, "以《BERT》为种子找相关论文");
  assert.equal(skillDigest("【科研技能 · 拆解方法】解剖《ResNet》（item_key=1512.03385）的方法。")?.label, "拆解《ResNet》的方法");
  assert.equal(skillDigest("【科研技能 · 寻找研究方向】围绕方向「多模态」找研究空白并产出选题。")?.label, "围绕「多模态」找研究空白");
  assert.equal(skillDigest("帮我看看这篇论文的公式推导"), null, "读者自己打的字不该被折叠");
  assert.equal(skillDigest("顺带提一句【科研技能 · 跨篇对比】这个按钮不好用"), null, "行中提到的不算工单");

  const comp = source("web/components.tsx");
  assert.match(comp, /const digest = useMemo\(\(\) => skillDigest\(text\), \[text\]\)/);
  assert.match(comp, /\{digest \? \(/, "有工单才走折叠分支");
  assert.match(comp, /查看发给模型的完整指令/, "展开入口要说明自己展开的是什么");
  assert.match(comp, /\{open && <div class="thinking-body">\{digest\.detail\}<\/div>\}/, "默认收起，且复用思考过程那套折叠");
  assert.match(comp, /<Markdown text=\{text\} \/>/, "普通提问照旧直接渲染");
});

test("跨任务对比只按场景给建议，禁止统一优劣排名", () => {
  const skills = source("core/skills.ts");
  const at = skills.indexOf("async function buildMatrix");
  assert.ok(at > 0 && skills.indexOf("// 4) Research Gap") > at, "切片范围要真的罩住 buildMatrix");
  const prompt = skills.slice(at, skills.indexOf("// 4) Research Gap"));
  assert.match(prompt, /短名/, "全表用同一个短名，读者才知道 [Transformer · p. 2] 指的是谁");
  assert.match(prompt, /芯片标签写成「短名 · p\. N」/, "芯片光写 p. N 认不出是谁的页码");
  assert.match(prompt, /\| 论文（年份，venue）<br>item_key=…/, "首列那一格要带上这一篇的 item_key");
  assert.match(prompt, /✅ \[Transformer · p\. 2\]\(page:2\?q=Attention%20Is%20All%20You%20Need&k=1706\.03762\)/, "正例里的芯片必须带 k=");
  assert.match(prompt, /❌ \[p\. 2\]\(page:2\?q=Attention%20Is%20All%20You%20Need\)/, "反例要写清楚：少 k= 的芯片看着能用，其实翻错论文");
  assert.match(prompt, /每一处 page: 链接都必须带 &k=/, "表格、正文、选型建议都不能漏");
  assert.match(prompt, /\[短名 · p\. N\]\(page:N&k=<item_key>\)/, "拿不准原句时的退让写法也得带 k=");
  assert.match(prompt, /禁止据此给出统一的优劣排名|禁止.*排名/);
  assert.match(prompt, /训练硬件（GPU 数量、训练时长）/, "不许拿算力数字当高下");
  assert.match(prompt, /按场景的选型建议/);
  assert.doesNotMatch(prompt, /一句话选型建议/, "旧的「按精度/算力排一遍」说法正是被禁的那种");
  assert.match(prompt, /一格要写两层信息就用 <br> 换行/, "现在 <br> 能正确渲染，鼓励分行而不是挤成一串");
  assert.match(prompt, /不是同条件对比/);
});

// ---------------------------------------------------------------- 4 首页预览定位与正文高度

test("从首页预览点页码进来：右侧停在那条结论，不是报告末尾", () => {
  const app = source("web/app.tsx");
  assert.match(app, /api\.events\.emit\(\{ type: "focus-report", itemKey: example\.itemKey, page: c\.page, quote: c\.quote \}\)/);
  assert.match(app, /api\.openPage\(example\.itemKey, c\.page, c\.quote/, "跳页+圈句这条老路径不变");

  const chat = source("web/chat.tsx");
  assert.match(chat, /if \(e\.type !== "focus-report"\) return;[\s\S]*nonce: \+\+focusNonce/, "面板是被这一次点击才挂载的，模块层先记账");
  assert.match(chat, /useState<CiteFocus \| null>\(\(\) => pendingFocus\)/, "初始 state 就要读到这次请求");
  assert.match(chat, /pendingFocus = null;\n\s*return reportFocus\.on\(setCiteFocus\);/, "只认这一次，之后回到读者自己滚过的位置");
  assert.match(chat, /focus=\{citeFocus && citeFocus\.itemKey === ctx\.ref\.itemKey \? citeFocus : null\}/, "换了别的论文就别再套上一次的定位");

  const comp = source("web/components.tsx");
  assert.match(comp, /function citeBlock\(el: HTMLElement, f: CiteFocus\)/);
  assert.match(comp, /a\.closest\("li, p, tr, blockquote"\)/, "定位到带引用的那一条，而不是整条消息的开头");
  assert.match(comp, /stick\.current = false;\n\s*settled\.current = true;/, "定位后必须关掉跟到底部，否则下一帧又回到末尾");
  assert.match(comp, /el\.scrollTop = Math\.max\(0, top - Math\.round\(el\.clientHeight \/ 3\)\)/, "停在视野上三分之一，左右两栏同时看得见");
  assert.match(comp, /hit\.classList\.add\("kb-flash"\)/, "闪一下，读者知道停的是哪条");
  assert.match(comp, /new MutationObserver\(\(\) => apply\(\) && mo\.disconnect\(\)\)/, "预置会话异步落盘，要等 DOM 而不是等帧：后台标签页里 rAF 根本不跑");
  assert.doesNotMatch(comp, /requestAnimationFrame\(step\)/, "按帧重试这套在隐藏标签页里是死路");
  assert.match(comp, /setTimeout\(\(\) => mo\.disconnect\(\), 10000\)/, "报告里真没有这条引用时要有尽头，不能一直挂着观察器");
});

test("正文可用的纵向空间：摘要区与额度条都收成一行级别", () => {
  const css = source("styles/chat.css");
  const conclusion = css.slice(css.indexOf(".conclusion {"), css.indexOf(".conclusion-title"));
  assert.match(conclusion, /max-height: 30%;/, "摘要区封顶从 40% 收到 30%");
  assert.match(conclusion, /padding: calc\(7px/, "上下留白同步收紧");
  assert.doesNotMatch(conclusion, /max-height: 40%/);
  assert.match(conclusion, /flex: 0 1 auto/, "摘要区参与收缩：整栏放不下时它得先让位，而不是把报告挤成二十像素");
  assert.match(conclusion, /min-height: 46px/, "让位也要留得住一行标题");
  assert.match(css, /\.scroll \{ flex: 1 1 0;/, "正文按 0 起步再长满剩余空间，而不是拿 scrollHeight 去参与收缩");
  assert.match(css, /\.pane-chat \.scroll \{ min-height: 132px; \}/, "报告栏有保底高度，芯片点击后才有地方停留");
  assert.match(css, /\.skill-box \{[^}]*flex: 0 1 auto; min-height: 0; overflow-y: auto;/, "工具箱矮屏时自己滚动，不把报告顶出可视区");
  const banner = css.slice(css.indexOf(".banner {"), css.indexOf("@media (prefers-color-scheme: dark) { .banner"));
  assert.match(banner, /padding: calc\(3px/, "额度条只占一行");
  assert.match(banner, /font-size: calc\(11\.5px/);
});
