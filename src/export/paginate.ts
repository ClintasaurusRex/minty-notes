/**
 * Page breaks for note-to-PDF export (pure). A note is one tall canvas; the
 * PDF shows it in horizontal bands, one band per sheet. A cut never goes
 * through a line of text or a picture that fits on one sheet; it prefers the
 * space between objects, then the space between paragraphs, and avoids
 * leaving a heading at the bottom of a sheet or splitting a table row.
 * Pictures taller than a sheet are split. Blank space at the top of a sheet is
 * skipped, so large gaps on the canvas never produce empty sheets.
 */

export interface Interval {
  top: number
  bottom: number
}

export interface TextLine extends Interval {
  /** A heading line: keep it with what follows. */
  heading?: boolean
}

export interface PaginationInput {
  /** Usable height of the first sheet and of later sheets, in canvas units. */
  firstHeight: number
  height: number
  /** Every drawn thing (for the content's extent and for skipping blank space). */
  items: Interval[]
  /** Lines of text: never cut through. */
  lines: TextLine[]
  /** Pictures and sketches: never cut through if they fit on a sheet. */
  solids: Interval[]
  /** Whole objects: a cut outside all of them is the most natural. */
  objects: Interval[]
  /** Table rows: avoid cutting inside one. */
  rows: Interval[]
  /** Paragraphs, list items, code blocks: prefer not to split one. */
  blocks: Interval[]
}

export interface Band {
  start: number
  end: number
  /** True when no clean place was found and the cut goes through content. */
  forced: boolean
}

const EPS = 0.5
const MIN_FILL = 0.55

const inside = (y: number, list: Interval[]) => list.some((r) => r.top < y - EPS && r.bottom > y + EPS)

/** First content at or after `y` (skips blank space); `Infinity` when nothing is left. */
function nextContent(y: number, items: Interval[]): number {
  let best = Infinity
  for (const r of items) {
    if (r.bottom <= y + EPS) continue
    best = Math.min(best, Math.max(r.top, y))
  }
  return best
}

export function paginate(input: PaginationInput): Band[] {
  const items = input.items.filter((r) => Number.isFinite(r.top) && Number.isFinite(r.bottom) && r.bottom > r.top)
  if (items.length === 0) return []
  const end = Math.max(...items.map((r) => r.bottom))
  const lines = [...input.lines].sort((a, b) => a.top - b.top)
  const bands: Band[] = []
  let start = nextContent(-Infinity, items)
  for (let guard = 0; guard < 10_000 && start < end - EPS; guard++) {
    const height = Math.max(1, bands.length === 0 ? input.firstHeight : input.height)
    const limit = start + height
    if (end <= limit + EPS) {
      bands.push({ start, end, forced: false })
      break
    }
    // Only what reaches into this sheet matters for its cut.
    const near = <T extends Interval>(list: T[]) => list.filter((r) => r.bottom > start && r.top < limit + EPS)
    // A solid that fits on a (full) sheet must not be cut; taller ones are split.
    const solids = near(input.solids).filter((s) => s.bottom - s.top <= Math.max(height, input.height))
    const sheetLines = near(lines)
    const objects = near(input.objects)
    const rows = near(input.rows)
    const blocks = near(input.blocks)
    const clean = (y: number) => y > start + EPS && y <= limit + EPS && !inside(y, sheetLines) && !inside(y, solids)
    const candidates = new Set<number>([limit])
    for (const list of [sheetLines, solids, objects, rows, blocks]) {
      for (const r of list) {
        if (r.top > start && r.top <= limit) candidates.add(r.top)
        if (r.bottom > start && r.bottom <= limit) candidates.add(r.bottom)
      }
    }
    const score = (y: number) => {
      let s = (y - start) / height
      if (!inside(y, objects)) s += 0.35
      if (inside(y, rows)) s -= 0.5
      if (inside(y, blocks)) s -= 0.12
      // A heading just above the cut, with more content below it, is stranded.
      let last: TextLine | undefined
      for (const l of sheetLines) if (l.bottom <= y + EPS && l.bottom > y - (l.bottom - l.top) * 2.5 && (!last || l.bottom >= last.bottom)) last = l
      if (last?.heading && y < end - EPS) s -= 0.6
      return s
    }
    const ok = [...candidates].filter(clean)
    let cut: number | null = null
    const preferred = ok.filter((y) => y >= start + height * MIN_FILL)
    const pool = preferred.length ? preferred : ok
    if (pool.length) {
      cut = pool.reduce((best, y) => {
        const a = score(y)
        const b = score(best)
        return a > b + 1e-9 || (Math.abs(a - b) <= 1e-9 && y > best) ? y : best
      })
    }
    if (cut === null && bands.length === 0 && solids.some((s) => s.top <= start + EPS && s.bottom > limit + EPS)) {
      // A picture right under the title fits on a full sheet but not on the first
      // (shorter) one: it moves to the next sheet whole instead of being split.
      bands.push({ start, end: start, forced: false })
      continue
    }
    const forced = cut === null
    const at = cut ?? limit
    bands.push({ start, end: at, forced })
    start = nextContent(at, items)
  }
  return bands
}

/** Which band a line of text belongs to: the first that contains its bottom (a forced cut moves it down). */
export function bandOf(bands: Band[], line: Interval): number {
  for (let i = 0; i < bands.length; i++) if (line.bottom <= bands[i].end + EPS) return i
  return bands.length - 1
}
