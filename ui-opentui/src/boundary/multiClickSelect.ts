/**
 * Multi-click selection — double-click selects the word, triple-click the
 * line, drag after either extends by word/line with the clicked span held
 * (boundary shim in the ffiSafe.ts / nativeHandles.ts mold).
 *
 * Why a shim: @opentui/core's renderer knows only press-drag character
 * selection — `processSingleMouseEvent` calls `startSelection(renderable,x,y)`
 * on a fresh left press and `updateSelection(renderable,x,y)` per drag step,
 * with no click-count concept. Wrapping those two INSTANCE methods is the
 * narrowest seam that adds multi-click without forking core: the press wrapper
 * counts clicks (Ink's 500ms / 1-cell chain) and, on a multi-click, seeds the
 * selection with the word/line span instead of a point; the drag wrapper snaps
 * the focus to word/line bounds and flips the selection anchor to whichever
 * end of the held span faces away from the pointer.
 *
 * Word/line bounds come from the presented frame (`currentRenderBuffer`'s
 * char grid — the same buffer `captureCharFrame` reads in tests), so what
 * highlights is exactly the run of characters the user sees. All wrapped paths
 * degrade to core's plain character selection when anything is off (no
 * buffer, destroyed renderer, out-of-bounds click) — selection must never
 * throw out of the mouse pipeline.
 */
import type { CliRenderer } from '@opentui/core'

import type { AnchorSpan, Point, ScreenText } from '../logic/multiClick.ts'
import { comparePoints, createClickCounter, extendedSelection, lineSpanAt, wordSpanAt } from '../logic/multiClick.ts'

/** The renderable surface the shim needs (anchor tracking reads live x/y). */
interface AnchorRenderable {
  readonly x: number
  readonly y: number
}

/** The private renderer surface the shim wraps (runtime-verified shapes). */
interface RendererSeam {
  startSelection(renderable: AnchorRenderable, x: number, y: number): void
  updateSelection(
    renderable: AnchorRenderable | undefined,
    x: number,
    y: number,
    options?: { finishDragging?: boolean }
  ): void
  currentRenderBuffer: {
    width: number
    height: number
    buffers: { char: Uint32Array }
  }
}

/** Adapt the presented frame to the pure logic's ScreenText; null when the
 *  buffer is unreadable (mid-teardown/resize) → degrade to char selection. */
function presentedFrame(seam: RendererSeam): ScreenText | null {
  try {
    const buffer = seam.currentRenderBuffer
    const chars = buffer.buffers.char
    const width = buffer.width
    if (width <= 0 || buffer.height <= 0) return null
    return {
      width,
      height: buffer.height,
      codepointAt: (x, y) => chars[y * width + x] ?? 0
    }
  } catch {
    return null
  }
}

/**
 * Native selection semantics (probed empirically, scratch test 2026-06-11):
 * per-renderable native selection keeps the anchor from the initial
 * `setLocalSelection` — the anchor args of later `updateLocalSelection` calls
 * are IGNORED, so moving the anchor requires restarting the selection. And the
 * selection is caret-style at the focus end: a forward selection covers cells
 * `[anchor, focus)` (focus cell excluded) while a backward one covers
 * `[focus, anchor]` (both included). Inclusive cell spans therefore translate
 * to: forward focus = `hi + 1`, backward focus = `lo` exactly.
 */
function forwardFocusX(anchor: Point, focus: Point): number {
  return comparePoints(focus, anchor) >= 0 ? focus.x + 1 : focus.x
}

/** Install the multi-click wrappers on a live renderer instance. */
export function installMultiClickSelection(renderer: CliRenderer): void {
  const seam = renderer as unknown as RendererSeam
  const nextClickCount = createClickCounter()

  // The held span while a multi-click selection is live: cleared by the next
  // single click (which starts a plain char selection). `anchor` mirrors the
  // selection's current anchor end so drag steps only rebind it on a flip.
  let held: { span: AnchorSpan; renderable: AnchorRenderable; anchor: Point } | null = null

  const coreStart = seam.startSelection.bind(renderer)
  const coreUpdate = seam.updateSelection.bind(renderer)

  seam.startSelection = (renderable, x, y) => {
    held = null
    const clicks = nextClickCount(x, y, Date.now())
    const screen = clicks >= 2 ? presentedFrame(seam) : null
    const span = screen ? (clicks === 2 ? wordSpanAt(screen, x, y) : lineSpanAt(screen, y)) : null
    if (!span) {
      coreStart(renderable, x, y)
      return
    }
    // Seed anchor at the span start, focus past its end (forward caret) — one
    // start+update pair, exactly the calls a real press-then-drag would make.
    coreStart(renderable, span.lo.x, span.lo.y)
    coreUpdate(renderable, span.hi.x + 1, span.hi.y)
    held = {
      span: { ...span, kind: clicks === 2 ? 'word' : 'line' },
      renderable,
      anchor: span.lo
    }
  }

  seam.updateSelection = (renderable, x, y, options) => {
    const screen = held ? presentedFrame(seam) : null
    if (!held || !screen) {
      coreUpdate(renderable, x, y, options)
      return
    }
    const { anchor, focus } = extendedSelection(held.span, screen, x, y)
    if (anchor.x !== held.anchor.x || anchor.y !== held.anchor.y) {
      // The anchor end flipped across the held span — native selection anchors
      // are fixed at set time (see forwardFocusX note), so restart it there.
      coreStart(held.renderable, anchor.x, anchor.y)
      held = { ...held, anchor }
    }
    coreUpdate(renderable, forwardFocusX(anchor, focus), focus.y, options)
  }
}
