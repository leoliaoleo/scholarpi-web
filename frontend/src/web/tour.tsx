/**
 * First-visit onboarding: three dismissible steps, no backdrop, so the workbench
 * stays usable while it is open. Dismissal is remembered in localStorage.
 */
import { useEffect, useState } from "preact/hooks";

const KEY = "scholarpi.tour";

const STEPS = [
  {
    t: "切换或上传论文",
    d: "左侧文献栏已内置 3 篇精读好的论文（Attention / ResNet / BERT）；也可以上传本地 PDF，或粘贴 arXiv ID / 链接即时抓取。",
  },
  {
    t: "划词、框图或直接提问",
    d: "在 PDF 里选中一句话，会浮出「翻译 / 解释 / 追问」等 AI 按钮；按住 Shift 拖框圈住图表或公式，可以就这块图像提问。右侧输入框则是整篇论文级别的对话。",
  },
  {
    t: "点击引用芯片跳页定位",
    d: "回答里的 p.N 芯片会让左边 PDF 跳到对应页，并把该结论依据的原文圈出来——每一句结论都能回查。",
  },
];

export function Tour() {
  const [step, setStep] = useState(-1);

  useEffect(() => {
    if (!localStorage.getItem(KEY)) setStep(0);
  }, []);

  useEffect(() => {
    if (step < 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") setStep((s) => Math.max(0, s - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  const finish = () => {
    localStorage.setItem(KEY, "1");
    setStep(-1);
  };
  const next = () => (step + 1 < STEPS.length ? setStep(step + 1) : finish());

  if (step < 0) return null;
  const s = STEPS[step];

  return (
    <div class="tour" role="dialog" aria-label="新手引导">
      <div class="tour-head">
        <b>3 步上手 ScholarPi</b>
        <span class="muted small">
          {step + 1} / {STEPS.length}
        </span>
        <button class="tour-x" onClick={finish} title="关闭引导（Esc）">
          ×
        </button>
      </div>
      <div class="tour-title">{s.t}</div>
      <div class="tour-body">{s.d}</div>
      <div class="tour-foot">
        <span class="tour-dots">
          {STEPS.map((_, i) => (
            <i key={i} class={i === step ? "on" : ""} />
          ))}
        </span>
        <span class="spacer" />
        {step > 0 && <button onClick={() => setStep(step - 1)}>上一步</button>}
        <button class="link-btn" onClick={finish}>
          跳过引导
        </button>
        <button class="primary" onClick={next}>
          {step + 1 < STEPS.length ? "下一步" : "开始使用"}
        </button>
      </div>
    </div>
  );
}
