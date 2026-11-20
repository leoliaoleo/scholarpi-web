/**
 * 复制反馈的口径。
 *
 * 剪贴板到底让不让写只有浏览器知道（`copyText` 负责判定与降级），这里只统一按钮文案、
 * 提示文案与那 2 秒的复位时长，免得两处入口各说各话。
 */

/** 按钮上「已复制 ✓」停留多久——够看清，又不会一直顶着。 */
export const COPY_FLASH_MS = 2000;

/** 报告还没生成完就点复制：不说成功，也不假装是浏览器的问题。 */
export const EMPTY_NOTE_HINT = "内容还是空的：等回答生成完再复制。";

export function copyButtonLabel(flash: boolean, idle = "复制 Markdown"): string {
  return flash ? "已复制 ✓" : idle;
}

/** `scope` 是这份笔记的范围名（精读报告 / 本条回答），复制的就是它、下载的也是它。 */
export function copyHint(scope: string, ok: boolean): string {
  return ok
    ? `已复制${scope}的 Markdown，可直接粘贴进笔记软件。`
    : `浏览器拒绝了剪贴板写入：已改为下载 ${scope} .md，也可以选中下面的文本自己复制。`;
}
