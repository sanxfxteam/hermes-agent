/**
 * Multi-click selection logic — double-click selects the word, triple-click the
 * line, and a drag after either extends word-by-word / line-by-line while the
 * originally clicked span stays selected (native macOS / VS Code behavior).
 * Ported from the Ink fork's `hermes-ink/src/ink/selection.ts` (wordBoundsAt /
 * selectLineAt / extendSelection) onto OpenTUI's screen model: the rendered
 * frame is a flat grid of codepoints (`OptimizedBuffer.buffers.char`), so word
 * scanning reads the frame the user actually sees — concealed markdown, tool
 * chrome and all.
 *
 * Pure string/number work, no OpenTUI imports — the boundary shim
 * (`boundary/multiClickSelect.ts`) adapts the live buffer to `ScreenText`.
 */

/** Screen-buffer cell coordinates (0-indexed col/row). */
export interface Point {
  readonly x: number
  readonly y: number
}

/** Inclusive span from `lo` to `hi` in reading order (row-major). */
export interface Span {
  readonly lo: Point
  readonly hi: Point
}

/** The multi-clicked span a drag extends from. */
export interface AnchorSpan extends Span {
  readonly kind: 'word' | 'line'
}

/** Read-only view of the rendered frame's character grid. */
export interface ScreenText {
  readonly width: number
  readonly height: number
  /** Unicode codepoint at cell (x,y); 0 marks a wide-char continuation cell. */
  readonly codepointAt: (x: number, y: number) => number
}

/** -1 if a < b, 1 if a > b, 0 if equal (reading order: row then col). */
export function comparePoints(a: Point, b: Point): number {
  if (a.y !== b.y) return a.y < b.y ? -1 : 1
  if (a.x !== b.x) return a.x < b.x ? -1 : 1
  return 0
}

// Unicode-aware word character matcher: letters (any script), digits, and the
// punctuation set iTerm2 treats as word-part by default (`/-+\~_.`). Matching
// iTerm2's default means double-clicking a path like `src/logic/multiClick.ts`
// selects the whole path — the muscle memory terminal users have.
const WORD_CHAR = /[\p{L}\p{N}_/.\-+~\\]/u

/**
 * Character class for double-click word-expansion: 0 = whitespace/empty,
 * 1 = word char, 2 = other punctuation. Cells with the same class as the
 * clicked cell are one run; a class change is a boundary — so double-click on
 * `foo` selects `foo`, on `->` selects `->`, on spaces the whitespace run.
 */
function charClass(cp: number): 0 | 1 | 2 {
  if (cp === 0 || cp === 32) return 0
  if (WORD_CHAR.test(String.fromCodePoint(cp))) return 1
  return 2
}

/**
 * Bounds of the same-class character run at (x, y), or null when the click is
 * out of bounds. Wide-char continuation cells (codepoint 0) belong to the head
 * glyph at their left: a click on one resolves to the head, the left scan
 * steps over them to the head's class, and the right scan includes them in the
 * span so the highlight covers the full glyph.
 */
export function wordSpanAt(screen: ScreenText, x: number, y: number): Span | null {
  if (y < 0 || y >= screen.height || x < 0 || x >= screen.width) return null

  // Land on a continuation cell → step back to the wide-char head.
  let c = x
  while (c > 0 && screen.codepointAt(c, y) === 0) c -= 1

  const cls = charClass(screen.codepointAt(c, y))

  let lo = c
  while (lo > 0) {
    let prev = lo - 1
    while (prev > 0 && screen.codepointAt(prev, y) === 0) prev -= 1
    if (charClass(screen.codepointAt(prev, y)) !== cls) break
    lo = prev
  }

  let hi = c
  while (hi < screen.width - 1) {
    const cp = screen.codepointAt(hi + 1, y)
    // A continuation cell after a run member is the tail of the run's last
    // wide glyph — include it and keep scanning.
    if (cp !== 0 && charClass(cp) !== cls) break
    hi += 1
  }

  return { lo: { x: lo, y }, hi: { x: hi, y } }
}

/** The full row as a span (triple-click). Null when the row is out of bounds —
 *  per-renderable `getSelectedText` trims what shouldn't copy, matching the
 *  Ink fork where line-select spans the visual row. */
export function lineSpanAt(screen: ScreenText, y: number): Span | null {
  if (y < 0 || y >= screen.height || screen.width <= 0) return null
  return { lo: { x: 0, y }, hi: { x: screen.width - 1, y } }
}

/**
 * Where a drag at (x, y) puts the selection while an anchor span is held:
 * the span under the mouse (word at the pointer, or its row in line mode;
 * raw cell fallback when the pointer is out of bounds) is merged with the
 * anchor span so the original word/line always stays selected.
 */
export function extendedSelection(
  span: AnchorSpan,
  screen: ScreenText,
  x: number,
  y: number
): { anchor: Point; focus: Point } {
  let mouseLo: Point
  let mouseHi: Point

  if (span.kind === 'word') {
    const b = wordSpanAt(screen, x, y)
    mouseLo = b ? b.lo : { x, y }
    mouseHi = b ? b.hi : { x, y }
  } else {
    const row = Math.max(0, Math.min(y, screen.height - 1))
    mouseLo = { x: 0, y: row }
    mouseHi = { x: screen.width - 1, y: row }
  }

  // Mouse target entirely before the anchor span → grow backward from its end;
  // entirely after → grow forward from its start; overlapping → just the span.
  if (comparePoints(mouseHi, span.lo) < 0) return { anchor: span.hi, focus: mouseLo }
  if (comparePoints(mouseLo, span.hi) > 0) return { anchor: span.lo, focus: mouseHi }
  return { anchor: span.lo, focus: span.hi }
}

/** Same chain window the Ink fork uses (`App.tsx` MULTI_CLICK_*). */
export const MULTI_CLICK_TIMEOUT_MS = 500
export const MULTI_CLICK_DISTANCE = 1

/**
 * Click-chain counter: a press within MULTI_CLICK_TIMEOUT_MS and
 * MULTI_CLICK_DISTANCE of the previous press continues the chain, otherwise
 * the count resets to 1. The returned count is capped at 3 — quadruple+
 * clicks stay line-select, like every terminal/editor.
 */
export function createClickCounter(): (x: number, y: number, now: number) => 1 | 2 | 3 {
  let lastTime = 0
  let lastX = -1
  let lastY = -1
  let count = 0

  return (x, y, now) => {
    const chained =
      now - lastTime <= MULTI_CLICK_TIMEOUT_MS &&
      Math.abs(x - lastX) <= MULTI_CLICK_DISTANCE &&
      Math.abs(y - lastY) <= MULTI_CLICK_DISTANCE
    count = chained ? count + 1 : 1
    lastTime = now
    lastX = x
    lastY = y
    return count >= 3 ? 3 : (count as 1 | 2)
  }
}
