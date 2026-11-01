/**
 * Pure page-geometry rules. Pages have a fixed width and grow downward.
 * All objects stay inside [0, pageWidth] horizontally and at y >= 0.
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const MIN_TEXT_WIDTH = 80
export const MIN_IMAGE_SIZE = 16
export const PAGE_MIN_HEIGHT = 1600
export const PAGE_BOTTOM_ROOM = 600
export const PLACEMENT_GAP = 16
export const PAGE_MARGIN = 48

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function round(value: number): number {
  return Math.round(value)
}

/** Keep a rect inside the page width and at nonnegative positions. */
export function clampRect(rect: Rect, pageWidth: number, minW = MIN_IMAGE_SIZE, minH = MIN_IMAGE_SIZE): Rect {
  const w = clamp(round(rect.w), Math.min(minW, pageWidth), pageWidth)
  const h = Math.max(round(rect.h), minH)
  const x = clamp(round(rect.x), 0, pageWidth - w)
  const y = Math.max(0, round(rect.y))
  return { x, y, w, h }
}

/** Move a rect by a delta, keeping it on the page. */
export function moveRect(start: Rect, dx: number, dy: number, pageWidth: number): Rect {
  const x = clamp(round(start.x + dx), 0, Math.max(0, pageWidth - start.w))
  const y = Math.max(0, round(start.y + dy))
  return { ...start, x, y }
}

export interface ResizeOptions {
  pageWidth: number
  minW: number
  minH: number
  /** Preserve the start aspect ratio (used for image corner handles). */
  keepAspect: boolean
}

/**
 * Resize a rect from a handle by a pointer delta. The opposite edge stays
 * anchored. The result never crosses the page edges or minimum sizes.
 */
export function resizeRect(start: Rect, handle: Handle, dx: number, dy: number, opts: ResizeOptions): Rect {
  const { pageWidth, minW, minH } = opts
  const west = handle.includes('w')
  const east = handle.includes('e')
  const north = handle.startsWith('n')
  const south = handle.startsWith('s')

  const right = start.x + start.w
  const bottom = start.y + start.h

  let w = start.w
  let h = start.h
  if (east) w = clamp(start.w + dx, minW, pageWidth - start.x)
  if (west) w = clamp(start.w - dx, minW, right)
  if (south) h = Math.max(minH, start.h + dy)
  if (north) h = clamp(start.h - dy, minH, bottom)

  const corner = (east || west) && (north || south)
  if (opts.keepAspect && corner && start.w > 0 && start.h > 0) {
    const ratio = start.w / start.h
    // Follow whichever axis changed more, then fit inside the limits.
    const scaleW = w / start.w
    const scaleH = h / start.h
    let scale = Math.abs(scaleW - 1) >= Math.abs(scaleH - 1) ? scaleW : scaleH
    const maxW = east ? pageWidth - start.x : right
    const maxH = north ? bottom : Number.POSITIVE_INFINITY
    scale = Math.min(scale, maxW / start.w, maxH / start.h)
    scale = Math.max(scale, minW / start.w, minH / start.h)
    w = start.w * scale
    h = w / ratio
  }

  const x = west ? right - w : start.x
  const y = north ? bottom - h : start.y
  return { x: round(x), y: round(y), w: round(w), h: round(h) }
}

/** Page height: never smaller than the minimum, always leaves room below content. */
export function pageHeight(rects: Iterable<Rect>): number {
  let bottom = 0
  for (const r of rects) bottom = Math.max(bottom, r.y + r.h)
  return Math.max(PAGE_MIN_HEIGHT, Math.ceil(bottom + PAGE_BOTTOM_ROOM))
}

export function intersects(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap
}

/**
 * Find the nearest free position at or below the desired one (same x),
 * so newly placed objects do not cover existing content.
 */
export function findFreeSpot(desired: Rect, others: Rect[], pageWidth: number, gap = PLACEMENT_GAP): Rect {
  const rect = clampRect(desired, pageWidth, 1, 1)
  let y = rect.y
  // Each iteration jumps past the lowest colliding object, so this terminates.
  for (let guard = 0; guard < 10000; guard++) {
    const candidate = { ...rect, y }
    const hits = others.filter((o) => intersects(candidate, o, gap))
    if (hits.length === 0) return candidate
    y = Math.max(...hits.map((o) => o.y + o.h + gap))
  }
  return { ...rect, y }
}

/**
 * Display size for a pasted image. Screenshots from high-DPI screens are
 * shown at their CSS-pixel size, then scaled down to fit the available width.
 */
export function fitImageSize(naturalW: number, naturalH: number, devicePixelRatio: number, maxW: number): { w: number; h: number } {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1
  let w = Math.max(1, naturalW / dpr)
  let h = Math.max(1, naturalH / dpr)
  if (w > maxW) {
    h = (h * maxW) / w
    w = maxW
  }
  return { w: Math.max(MIN_IMAGE_SIZE, Math.round(w)), h: Math.max(MIN_IMAGE_SIZE, Math.round(h)) }
}

/** Scale used to show the whole page width in the available space (never enlarges). */
export function fitScale(availableWidth: number, pageWidth: number): number {
  if (availableWidth <= 0) return 1
  return Math.min(1, Math.max(0.25, availableWidth / pageWidth))
}
