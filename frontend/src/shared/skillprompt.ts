/**
 * 技能按钮发出去的那条消息，其实是几百字写给模型看的工单：卡片清单、列名、输出格式、
 * 引用格式全在里面。读者在会话流里要认的是「我刚才让工具干了什么」，不是复读工单，
 * 所以这里只从原文里抽出一句话摘要，展开时仍然显示逐字原文（不改内容，只改默认可见范围）。
 */

export interface SkillDigest {
  /** 技能名，取自行首的「【科研技能 · X】」。 */
  skill: string;
  /** 折叠态显示的一句话。 */
  label: string;
  /** 展开态显示的原文，一字不动。 */
  detail: string;
}

const HEAD = /^【科研技能 · ([^】]+)】/;

/** 只认行首的技能工单；用户自己打字的提问（哪怕提到技能名）不折叠。 */
export function skillDigest(text: string): SkillDigest | null {
  const body = String(text || "");
  const m = HEAD.exec(body.trim());
  if (!m) return null;
  const skill = m[1].trim();
  const rest = body.trim().slice(m[0].length);
  const of = (re: RegExp) => re.exec(rest)?.[1]?.trim() || "";
  switch (skill) {
    case "跨篇对比": {
      const n = /对比下面\s*(\d+)\s*篇/.exec(rest)?.[1];
      return { skill, label: n ? `对比这 ${n} 篇论文` : "跨篇对比这几篇论文", detail: body };
    }
    case "找相关论文": {
      const seed = clip(of(/以《([^》]+)》/));
      return { skill, label: seed ? `以《${seed}》为种子找相关论文` : "找与这篇论文相关的工作", detail: body };
    }
    case "拆解方法": {
      const seed = clip(of(/解剖《([^》]+)》/));
      return { skill, label: seed ? `拆解《${seed}》的方法` : "拆解这篇论文的方法", detail: body };
    }
    case "寻找研究方向": {
      const q = clip(of(/围绕方向「([^」]+)」/));
      return { skill, label: q ? `围绕「${q}」找研究空白` : "找研究空白并产出选题", detail: body };
    }
    default:
      return { skill, label: `技能：${skill}`, detail: body };
  }
}

function clip(s: string, n = 40): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
