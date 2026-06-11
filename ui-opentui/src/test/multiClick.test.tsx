/**
 * Multi-click selection (double-click word, triple-click line, drag-extend
 * with the clicked span held). Layers:
 *   1. pure: word/line span scanning over a fake char grid + the click-chain
 *      counter + the extend arithmetic (logic/multiClick.ts).
 *   2. frames: the real mouse path through the shim (boundary/multiClickSelect.ts,
 *      installed by test/lib/render.ts exactly like the live renderer) — what
 *      the user double/triple-clicks is what getSelectedText() returns, and a
 *      held drag grows the selection without losing the original word.
 */
import { describe, expect, test } from 'vitest'

import {
  createClickCounter,
  extendedSelection,
  lineSpanAt,
  wordSpanAt,
  type AnchorSpan,
  type ScreenText
} from '../logic/multiClick.ts'
import { renderProbe } from './lib/render.ts'

/** Build a ScreenText from string rows; '\0' marks a wide-char continuation cell. */
function screenOf(...rows: string[]): ScreenText {
  const width = Math.max(...rows.map(row => row.length))
  return {
    width,
    height: rows.length,
    codepointAt: (x, y) => {
      const ch = rows[y]?.[x]
      if (ch === undefined) return 32
      return ch === '\0' ? 0 : ch.codePointAt(0)!
    }
  }
}

describe('wordSpanAt — same-class run scanning', () => {
  const screen = screenOf('alpha beta-gamma --> "quoted"')
  //                       0123456789...

  test('click inside a word selects the word run', () => {
    expect(wordSpanAt(screen, 2, 0)).toEqual({ lo: { x: 0, y: 0 }, hi: { x: 4, y: 0 } })
  })

  test('hyphen/path chars are word chars (iTerm2 set): beta-gamma is one run', () => {
    expect(wordSpanAt(screen, 8, 0)).toEqual({ lo: { x: 6, y: 0 }, hi: { x: 15, y: 0 } })
  })

  test('click on whitespace selects the whitespace run', () => {
    expect(wordSpanAt(screen, 5, 0)).toEqual({ lo: { x: 5, y: 0 }, hi: { x: 5, y: 0 } })
  })

  test('punctuation run (not word, not space) is its own class', () => {
    // `-->`: `-` and `>` … `-` is a word char in the iTerm2 set, so the run
    // splits: `--` belongs to word class, `>` is punctuation. Click the `>`.
    expect(wordSpanAt(screen, 19, 0)).toEqual({ lo: { x: 19, y: 0 }, hi: { x: 19, y: 0 } })
  })

  test('quotes break a word run', () => {
    expect(wordSpanAt(screen, 23, 0)).toEqual({ lo: { x: 22, y: 0 }, hi: { x: 27, y: 0 } })
  })

  test('out of bounds → null', () => {
    expect(wordSpanAt(screen, -1, 0)).toBeNull()
    expect(wordSpanAt(screen, 0, 1)).toBeNull()
    expect(wordSpanAt(screen, screen.width, 0)).toBeNull()
  })

  test('wide-char continuation cells join their head run', () => {
    // "日\0本\0 x" — two wide glyphs (head + continuation) then space + x.
    const wide = screenOf('日\0本\0 x')
    // Click the continuation cell of 日 → run covers both glyphs incl. tails.
    expect(wordSpanAt(wide, 1, 0)).toEqual({ lo: { x: 0, y: 0 }, hi: { x: 3, y: 0 } })
    expect(wordSpanAt(wide, 5, 0)).toEqual({ lo: { x: 5, y: 0 }, hi: { x: 5, y: 0 } })
  })
})

describe('lineSpanAt', () => {
  test('full row span, null out of bounds', () => {
    const screen = screenOf('one', 'two')
    expect(lineSpanAt(screen, 1)).toEqual({ lo: { x: 0, y: 1 }, hi: { x: 2, y: 1 } })
    expect(lineSpanAt(screen, 2)).toBeNull()
    expect(lineSpanAt(screen, -1)).toBeNull()
  })
})

describe('extendedSelection — drag with the clicked span held', () => {
  const screen = screenOf('alpha beta gamma')
  const beta: AnchorSpan = { lo: { x: 6, y: 0 }, hi: { x: 9, y: 0 }, kind: 'word' }

  test('drag forward grows from the span start to the word under the mouse', () => {
    expect(extendedSelection(beta, screen, 13, 0)).toEqual({
      anchor: { x: 6, y: 0 },
      focus: { x: 15, y: 0 }
    })
  })

  test('drag backward flips the anchor to the span end', () => {
    expect(extendedSelection(beta, screen, 2, 0)).toEqual({
      anchor: { x: 9, y: 0 },
      focus: { x: 0, y: 0 }
    })
  })

  test('mouse over the span keeps exactly the span', () => {
    expect(extendedSelection(beta, screen, 7, 0)).toEqual({
      anchor: { x: 6, y: 0 },
      focus: { x: 9, y: 0 }
    })
  })

  test('line mode extends row-by-row and clamps to the grid', () => {
    const lines = screenOf('one', 'two', 'three')
    const middle: AnchorSpan = { lo: { x: 0, y: 1 }, hi: { x: 4, y: 1 }, kind: 'line' }
    expect(extendedSelection(middle, lines, 1, 9)).toEqual({
      anchor: { x: 0, y: 1 },
      focus: { x: 4, y: 2 }
    })
    expect(extendedSelection(middle, lines, 1, -5)).toEqual({
      anchor: { x: 4, y: 1 },
      focus: { x: 0, y: 0 }
    })
  })
})

describe('createClickCounter — the 500ms / 1-cell chain', () => {
  test('chains at the same spot, caps at 3, resets on distance and time', () => {
    const count = createClickCounter()
    expect(count(10, 5, 1000)).toBe(1)
    expect(count(10, 5, 1100)).toBe(2)
    expect(count(11, 5, 1200)).toBe(3) // 1 cell of slop allowed
    expect(count(11, 5, 1300)).toBe(3) // quadruple+ stays line-select
    expect(count(14, 5, 1350)).toBe(1) // too far → fresh chain
    expect(count(14, 5, 1900)).toBe(1) // too late → fresh chain
  })
})

describe('frames — the real mouse path', () => {
  const LINE_ONE = 'alpha beta-gamma delta'
  const LINE_TWO = 'second row of words'

  async function mountLines() {
    const probe = await renderProbe(
      () => (
        <box flexDirection="column">
          <text content={LINE_ONE} />
          <text content={LINE_TWO} />
        </box>
      ),
      { height: 6, width: 40 }
    )
    const frame = await probe.waitForFrame(f => f.includes('alpha') && f.includes('second'))
    const rows = frame.split('\n')
    const y1 = rows.findIndex(row => row.includes('alpha'))
    const y2 = rows.findIndex(row => row.includes('second'))
    expect(y1).toBeGreaterThanOrEqual(0)
    expect(y2).toBeGreaterThanOrEqual(0)
    const x = (token: string) => {
      const col = (rows[y1] ?? '').indexOf(token)
      expect(col).toBeGreaterThanOrEqual(0)
      return col
    }
    return { probe, rows, y1, y2, x }
  }

  test('double-click selects the word under the cursor', async () => {
    const { probe, x, y1 } = await mountLines()
    try {
      await probe.mouse.doubleClick(x('alpha') + 1, y1)
      await probe.settle()
      expect(probe.selectedText()).toBe('alpha')
    } finally {
      probe.destroy()
    }
  })

  test('double-click on a hyphenated token selects the whole token', async () => {
    const { probe, x, y1 } = await mountLines()
    try {
      await probe.mouse.doubleClick(x('beta') + 2, y1)
      await probe.settle()
      expect(probe.selectedText()).toBe('beta-gamma')
    } finally {
      probe.destroy()
    }
  })

  test('triple-click selects the line', async () => {
    const { probe, x, y1 } = await mountLines()
    try {
      const col = x('beta')
      await probe.mouse.doubleClick(col, y1)
      await probe.mouse.click(col, y1)
      await probe.settle()
      expect(probe.selectedText().trimEnd()).toBe(LINE_ONE)
    } finally {
      probe.destroy()
    }
  })

  test('double-click then drag extends word-by-word without losing the word', async () => {
    const { probe, x, y1 } = await mountLines()
    try {
      const col = x('beta') + 1
      await probe.mouse.click(col, y1)
      await probe.mouse.pressDown(col, y1) // second press of the chain → word held
      await probe.mouse.moveTo(x('delta') + 1, y1) // drag into the next word
      await probe.mouse.release(x('delta') + 1, y1)
      await probe.settle()
      expect(probe.selectedText()).toBe('beta-gamma delta')
    } finally {
      probe.destroy()
    }
  })

  test('double-click then drag backward keeps the word and grows left', async () => {
    const { probe, x, y1 } = await mountLines()
    try {
      const col = x('beta') + 1
      await probe.mouse.click(col, y1)
      await probe.mouse.pressDown(col, y1)
      await probe.mouse.moveTo(x('alpha') + 1, y1)
      await probe.mouse.release(x('alpha') + 1, y1)
      await probe.settle()
      expect(probe.selectedText()).toBe('alpha beta-gamma')
    } finally {
      probe.destroy()
    }
  })

  test('triple-click then drag extends line-by-line', async () => {
    const { probe, x, y1, y2 } = await mountLines()
    try {
      const col = x('beta')
      await probe.mouse.doubleClick(col, y1)
      await probe.mouse.pressDown(col, y1) // third press of the chain → line held
      await probe.mouse.moveTo(col, y2)
      await probe.mouse.release(col, y2)
      await probe.settle()
      const text = probe.selectedText()
      expect(text).toContain(LINE_ONE)
      expect(text).toContain(LINE_TWO)
    } finally {
      probe.destroy()
    }
  })

  test('a plain drag still does character selection', async () => {
    const { probe, x, y1 } = await mountLines()
    try {
      // Far from any prior click (fresh probe) — drag from inside `alpha` to
      // inside `beta-gamma`; chars, not words.
      await probe.mouse.drag(x('alpha') + 2, y1, x('beta') + 2, y1)
      await probe.settle()
      expect(probe.selectedText()).toBe('pha be')
    } finally {
      probe.destroy()
    }
  })
})
