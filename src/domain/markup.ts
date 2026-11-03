import type { Annotation, AnnotationKind, Markup, MarkupRect } from './types'

/**
 * Image markup and sketches (format 4), as pure rules: validation, geometry,
 * and crop sizing. Rendering lives in the UI (SVG on the page, canvas for
 * flattened PNG copies).
 *
 * Blur and redaction are defined as follows:
 * - **blur** is visual only. The page shows the area blurred; the stored
 *   original keeps every pixel, and blurred text can sometimes be recovered.
 * - **redact** is an opaque cover. The page shows a solid box; the stored
 *   original still keeps the pixels underneath (backups contain them too).
 *   Only a flattened PNG copy replaces the covered pixels with solid colour.
 */

export const MAX_MARKUP_ITEMS = 2000
/** Coordinates in one pen stroke (x, y pairs). */
export const MAX_PEN_VALUES = 20_000
export const MAX_LABEL_LENGTH = 2000
export const MAX_MARKUP_SIZE = 20_000

export const ANNOTATION_KINDS: AnnotationKind[] = ['arrow', 'line', 'rect', 'ellipse', 'text', 'pen', 'highlighter', 'blur', 'redact']

/** Palette offered in the editor (any `#rrggbb` is valid in stored data). */
export const MARKUP_COLORS: { name: string; value: string }[] = [
  { name: 'Red', value: '#ef4444' },
  { name: 'Amber', value: '#f59e0b' },
  { name: 'Yellow', value: '#facc15' },
  { name: 'Mint', value: '#6ee7b7' },
  { name: 'Blue', value: '#60a5fa' },
  { name: 'White', value: '#ffffff' },
  { name: 'Black', value: '#111111' },
]

export const REDACT_COLOR = '#000000'

export const isColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)
const num = (v: unknown, lo = -MAX_MARKUP_SIZE * 2, hi = MAX_MARKUP_SIZE * 3): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200

export function emptyMarkup(width: number, height: number): Markup {
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)), crop: null, items: [] }
}

/** True when a markup changes how the image looks (crop or any item). */
export function hasMarkup(m: Markup | undefined): m is Markup {
  return !!m && (!!m.crop || m.items.length > 0)
}

/** The part of the coordinate space that is shown. */
export function visibleRect(m: Markup): MarkupRect {
  return m.crop ?? { x: 0, y: 0, w: m.width, h: m.height }
}

function itemProblem(a: unknown): string | null {
  if (typeof a !== 'object' || a === null) return 'an annotation is not an object'
  const o = a as Record<string, unknown>
  if (!isId(o.id)) return 'an annotation has no valid id'
  switch (o.kind) {
    case 'arrow':
    case 'line':
      return num(o.x1) && num(o.y1) && num(o.x2) && num(o.y2) && isColor(o.color) && num(o.width, 0.1, 500) ? null : `a ${o.kind} is invalid`
    case 'rect':
    case 'ellipse':
      return num(o.x) && num(o.y) && num(o.w, 0) && num(o.h, 0) && isColor(o.color) && num(o.width, 0, 500) && (o.fill === null || isColor(o.fill)) ? null : `a ${o.kind} is invalid`
    case 'text':
      return num(o.x) && num(o.y) && typeof o.text === 'string' && o.text.length <= MAX_LABEL_LENGTH && isColor(o.color) && num(o.size, 1, 2000) && (o.background === null || isColor(o.background)) ? null : 'a text label is invalid'
    case 'pen':
    case 'highlighter':
      return Array.isArray(o.points) && o.points.length >= 2 && o.points.length % 2 === 0 && o.points.length <= MAX_PEN_VALUES && o.points.every((p) => num(p)) && isColor(o.color) && num(o.width, 0.1, 1000)
        ? null
        : `a ${o.kind} stroke is invalid`
    case 'blur':
    case 'redact':
      return num(o.x) && num(o.y) && num(o.w, 0) && num(o.h, 0) ? null : `a ${o.kind} area is invalid`
    default:
      return 'an annotation has an unknown kind'
  }
}

/** Returns null when valid, or a readable reason. `allowCrop` is false for sketches. */
export function validateMarkup(m: unknown, allowCrop: boolean): string | null {
  if (typeof m !== 'object' || m === null) return 'markup is not an object'
  const o = m as Record<string, unknown>
  if (!num(o.width, 1, MAX_MARKUP_SIZE) || !num(o.height, 1, MAX_MARKUP_SIZE)) return 'markup has an invalid size'
  if (o.crop !== null) {
    if (!allowCrop) return 'a sketch cannot be cropped'
    const c = o.crop as Record<string, unknown>
    const ok = typeof c === 'object' && c !== null && num(c.x, 0) && num(c.y, 0) && num(c.w, 1) && num(c.h, 1) && c.x + c.w <= o.width + 0.5 && c.y + c.h <= o.height + 0.5
    if (!ok) return 'markup has an invalid crop'
  }
  if (!Array.isArray(o.items) || o.items.length > MAX_MARKUP_ITEMS) return 'markup has an invalid item list'
  const ids = new Set<string>()
  for (const item of o.items) {
    const p = itemProblem(item)
    if (p) return p
    const id = (item as { id: string }).id
    if (ids.has(id)) return 'markup has a duplicate annotation id'
    ids.add(id)
  }
  return null
}

const r2 = (v: number) => Math.round(v * 100) / 100

/** Coordinates rounded to 0.01 units (pointer maths leaves long fractions). */
export function roundMarkup(m: Markup): Markup {
  return {
    ...m,
    crop: m.crop ? { x: r2(m.crop.x), y: r2(m.crop.y), w: r2(m.crop.w), h: r2(m.crop.h) } : null,
    items: m.items.map((a) => {
      const out: Record<string, unknown> = { ...a }
      for (const [k, v] of Object.entries(a)) {
        if (typeof v === 'number') out[k] = r2(v)
        else if (k === 'points' && Array.isArray(v)) out[k] = (v as number[]).map(r2)
      }
      return out as Annotation
    }),
  }
}

/** Text labels, for search. */
export function markupText(m: Markup | undefined): string {
  if (!m) return ''
  return m.items
    .flatMap((a) => (a.kind === 'text' && a.text.trim() ? [a.text] : []))
    .join('\n')
}

export function normalizeRect(x1: number, y1: number, x2: number, y2: number): MarkupRect {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }
}

/** Approximate label width when no text measurer is available (tests, validation). */
export function approxTextWidth(text: string, size: number): number {
  return Math.max(...text.split('\n').map((l) => l.length), 1) * size * 0.58
}

export const LABEL_LINE_HEIGHT = 1.25
export const LABEL_PAD = 0.25

/** Box around an annotation (labels use `measure` when given, else an estimate). */
export function itemBounds(a: Annotation, measure: (text: string, size: number) => number = approxTextWidth): MarkupRect {
  switch (a.kind) {
    case 'arrow':
    case 'line':
      return normalizeRect(a.x1, a.y1, a.x2, a.y2)
    case 'text': {
      const lines = a.text.split('\n').length
      const pad = a.size * LABEL_PAD
      return { x: a.x - pad, y: a.y - pad, w: measure(a.text, a.size) + pad * 2, h: lines * a.size * LABEL_LINE_HEIGHT + pad * 2 }
    }
    case 'pen':
    case 'highlighter': {
      let x1 = Infinity
      let y1 = Infinity
      let x2 = -Infinity
      let y2 = -Infinity
      for (let i = 0; i < a.points.length; i += 2) {
        x1 = Math.min(x1, a.points[i])
        x2 = Math.max(x2, a.points[i])
        y1 = Math.min(y1, a.points[i + 1])
        y2 = Math.max(y2, a.points[i + 1])
      }
      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
    }
    default:
      return { x: a.x, y: a.y, w: a.w, h: a.h }
  }
}

export function moveItem(a: Annotation, dx: number, dy: number): Annotation {
  switch (a.kind) {
    case 'arrow':
    case 'line':
      return { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy }
    case 'pen':
    case 'highlighter':
      return { ...a, points: a.points.map((v, i) => v + (i % 2 === 0 ? dx : dy)) }
    default:
      return { ...a, x: a.x + dx, y: a.y + dy }
  }
}

export type MarkupHandle = 'start' | 'end' | 'nw' | 'ne' | 'se' | 'sw'

/** Drag handles for the selected annotation (pen strokes and labels only move). */
export function itemHandles(a: Annotation): { handle: MarkupHandle; x: number; y: number }[] {
  if (a.kind === 'arrow' || a.kind === 'line') {
    return [
      { handle: 'start', x: a.x1, y: a.y1 },
      { handle: 'end', x: a.x2, y: a.y2 },
    ]
  }
  if (a.kind === 'rect' || a.kind === 'ellipse' || a.kind === 'blur' || a.kind === 'redact') {
    return [
      { handle: 'nw', x: a.x, y: a.y },
      { handle: 'ne', x: a.x + a.w, y: a.y },
      { handle: 'se', x: a.x + a.w, y: a.y + a.h },
      { handle: 'sw', x: a.x, y: a.y + a.h },
    ]
  }
  return []
}

/** Move one handle to (x, y). Rectangles keep the opposite corner fixed. */
export function dragHandle(a: Annotation, handle: MarkupHandle, x: number, y: number): Annotation {
  if (a.kind === 'arrow' || a.kind === 'line') return handle === 'start' ? { ...a, x1: x, y1: y } : { ...a, x2: x, y2: y }
  if (a.kind === 'rect' || a.kind === 'ellipse' || a.kind === 'blur' || a.kind === 'redact') {
    const fixed = { nw: [a.x + a.w, a.y + a.h], ne: [a.x, a.y + a.h], se: [a.x, a.y], sw: [a.x + a.w, a.y] }[handle as 'nw' | 'ne' | 'se' | 'sw']
    if (!fixed) return a
    return { ...a, ...normalizeRect(fixed[0], fixed[1], x, y) }
  }
  return a
}

/** Keyboard resize: change width/height (rectangles) or move the end point (lines). */
export function resizeBy(a: Annotation, dw: number, dh: number): Annotation {
  if (a.kind === 'arrow' || a.kind === 'line') return { ...a, x2: a.x2 + dw, y2: a.y2 + dh }
  if (a.kind === 'rect' || a.kind === 'ellipse' || a.kind === 'blur' || a.kind === 'redact') return { ...a, w: Math.max(1, a.w + dw), h: Math.max(1, a.h + dh) }
  if (a.kind === 'text') return { ...a, size: Math.max(4, Math.min(2000, a.size + dh)) }
  return a
}

/** Arrowhead triangle at (x2, y2), sized from the stroke width. */
export function arrowHead(x1: number, y1: number, x2: number, y2: number, width: number): [number, number][] {
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const len = Math.max(10, width * 4)
  const spread = Math.PI / 7
  return [
    [x2, y2],
    [x2 - len * Math.cos(angle - spread), y2 - len * Math.sin(angle - spread)],
    [x2 - len * Math.cos(angle + spread), y2 - len * Math.sin(angle + spread)],
  ]
}

/** Drop points closer than `tolerance` to the previous kept point (keeps strokes small). */
export function simplifyPoints(points: number[], tolerance: number): number[] {
  if (points.length <= 4) return points.slice()
  const out = [points[0], points[1]]
  for (let i = 2; i < points.length - 2; i += 2) {
    const dx = points[i] - out[out.length - 2]
    const dy = points[i + 1] - out[out.length - 1]
    if (dx * dx + dy * dy >= tolerance * tolerance) out.push(points[i], points[i + 1])
  }
  out.push(points[points.length - 2], points[points.length - 1])
  return out.slice(0, MAX_PEN_VALUES)
}

/** A comfortable default stroke width for a coordinate space (thicker for big screenshots). */
export function defaultStrokeWidth(size: { width: number; height: number }): number {
  return Math.max(2, Math.round(Math.min(size.width, size.height) / 180))
}

/** Keep a crop rectangle inside the image, at least `min` units in each direction. */
export function clampCrop(c: MarkupRect, width: number, height: number, min = 8): MarkupRect {
  const w = Math.min(Math.max(Math.round(c.w), Math.min(min, width)), width)
  const h = Math.min(Math.max(Math.round(c.h), Math.min(min, height)), height)
  const x = Math.min(Math.max(Math.round(c.x), 0), width - w)
  const y = Math.min(Math.max(Math.round(c.y), 0), height - h)
  return { x, y, w, h }
}

/** Crop to store: null when it covers the whole image. */
export function storedCrop(c: MarkupRect | null, width: number, height: number): MarkupRect | null {
  if (!c) return null
  const k = clampCrop(c, width, height)
  return k.x === 0 && k.y === 0 && k.w === width && k.h === height ? null : k
}

/**
 * New on-page size after the visible part of an image changes: the display
 * scale (page px per image px) stays the same, so the picture does not jump in
 * size; the result is kept inside the page width.
 */
export function sizeAfterCrop(obj: { x: number; w: number; h: number }, before: MarkupRect, after: MarkupRect, pageWidth: number): { x: number; w: number; h: number } {
  const scale = before.w > 0 ? obj.w / before.w : 1
  let w = Math.max(1, after.w * scale)
  let h = Math.max(1, after.h * scale)
  if (w > pageWidth) {
    h = (h * pageWidth) / w
    w = pageWidth
  }
  const x = Math.min(obj.x, Math.max(0, pageWidth - w))
  return { x: Math.round(x), w: Math.round(w), h: Math.round(h) }
}
