/**
 * Desktop layout rules for the three-pane workbench, kept out of the component so
 * the 1280 / 1366 / 1440 / 125%-zoom cases can be asserted with `node --test`.
 */

/** At or below this CSS width the rail turns into a drawer: reading needs the room. */
export const NARROW_VW = 1500;
export const RAIL_W = 268;
export const RAIL_NARROW_W = 216;
export const RAIL_EDGE_W = 56;
export const SPLITTER_W = 5;
/** Never let the reader column fall below this, even if it means shrinking the chat. */
export const MIN_READER_W = 380;
export const CHAT_MIN_W = 320;
export const CHAT_MAX_W = 760;

export function railWidth(innerWidth: number): number {
  return innerWidth <= 1080 ? RAIL_NARROW_W : RAIL_W;
}

/**
 * `scholarpi.rail` records an explicit choice ("1" open / "0" closed). Without one,
 * narrow desktops start closed so the PDF and the report both get real width.
 */
export function railCollapsed(stored: string | null, innerWidth: number): boolean {
  if (stored === "1") return false;
  if (stored === "0") return true;
  return innerWidth <= NARROW_VW;
}

/** Fit the chat column inside the viewport, always leaving MIN_READER_W for the PDF. */
export function clampChatW(wanted: number, innerWidth: number, collapsed: boolean): number {
  const rail = collapsed ? RAIL_EDGE_W : railWidth(innerWidth);
  const cap = Math.min(CHAT_MAX_W, innerWidth - rail - SPLITTER_W - MIN_READER_W);
  return Math.max(CHAT_MIN_W, Math.min(wanted, cap));
}

/** The pet docks to the chat column; on narrow desktops it starts as a side bubble. */
export function petMiniDefault(innerWidth: number): boolean {
  return innerWidth <= NARROW_VW;
}
