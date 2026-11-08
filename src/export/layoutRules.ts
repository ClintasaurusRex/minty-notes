/**
 * Pure rules for note-to-PDF layout: sheet sizes, the scale that fits the
 * note's content width (never enlarged, never squeezed to fit its height),
 * automatic orientation, and the push-down that keeps text which grew in the
 * export from covering what was below it.
 */

export type Paper = 'letter' | 'a4'
export type Orientation = 'auto' | 'portrait' | 'landscape'

/** Sheet sizes in points (1/72 inch), portrait. */
export const PAPER_SIZES: Record<Paper, { width: number; height: number; label: string }> = {
  letter: { width: 612, height: 792, label: 'Letter (8.5 × 11 in)' },
  a4: { width: 595.28, height: 841.89, label: 'A4 (210 × 297 mm)' },
}

/** Sheet margins, and the band at the bottom reserved for the page footer (points). */
export const MARGIN = 36
export const FOOTER_BAND = 20

/** One CSS pixel is 0.75 pt at 100 %. */
export const PT_PER_PX = 0.75

/** Below this scale in portrait (about 9 pt body text), automatic orientation picks landscape. */
export const AUTO_LANDSCAPE_BELOW = 0.78

export interface Sheet {
  width: number
  height: number
  orientation: 'portrait' | 'landscape'
  /** Canvas pixels → PDF points multiplier is `scale × PT_PER_PX`. */
  scale: number
}

function scaleFor(sheetWidth: number, contentWidthPx: number): number {
  const avail = (sheetWidth - 2 * MARGIN) / PT_PER_PX
  return contentWidthPx > 0 ? Math.min(1, avail / contentWidthPx) : 1
}

/** The sheet for a note whose content is `contentWidthPx` wide (canvas pixels). */
export function chooseSheet(paper: Paper, orientation: Orientation, contentWidthPx: number): Sheet {
  const p = PAPER_SIZES[paper]
  const portrait: Sheet = { width: p.width, height: p.height, orientation: 'portrait', scale: scaleFor(p.width, contentWidthPx) }
  const landscape: Sheet = { width: p.height, height: p.width, orientation: 'landscape', scale: scaleFor(p.height, contentWidthPx) }
  if (orientation === 'portrait') return portrait
  if (orientation === 'landscape') return landscape
  return portrait.scale < AUTO_LANDSCAPE_BELOW && landscape.scale > portrait.scale ? landscape : portrait
}

export interface Placed {
  id: string
  x: number
  y: number
  w: number
  /** Height on the canvas, and height in the export (text can differ slightly). */
  h: number
  newH: number
}

/** How far objects may already overlap and still count as "above" one another (px). */
const OVERLAP_TOLERANCE = 16

/**
 * New y for each object: when a text box is taller in the export than on the
 * canvas, everything below it (that it overlaps horizontally, directly or
 * through a chain) moves down by the same amount, so nothing is covered.
 * Gaps are kept; nothing moves up.
 */
export function pushDown(objects: Placed[]): Map<string, number> {
  const order = [...objects].sort((a, b) => a.y - b.y || a.x - b.x)
  const shift = new Map<string, number>()
  for (let i = 0; i < order.length; i++) {
    const b = order[i]
    let s = 0
    for (let j = 0; j < i; j++) {
      const a = order[j]
      const overlapsX = a.x < b.x + b.w && b.x < a.x + a.w
      if (!overlapsX || a.y >= b.y || a.y + a.h > b.y + OVERLAP_TOLERANCE) continue
      s = Math.max(s, (shift.get(a.id) ?? 0) + Math.max(0, a.newH - a.h))
    }
    shift.set(b.id, s)
  }
  return new Map(objects.map((o) => [o.id, o.y + (shift.get(o.id) ?? 0)]))
}

/** A safe file name for the exported PDF. */
export function pdfFileName(title: string): string {
  const visible = [...title].map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? '-' : c)).join('')
  const base = visible
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.-]+|[\s.]+$/g, '')
    .slice(0, 120)
    .trim()
  return `${base || 'Note'}.pdf`
}
