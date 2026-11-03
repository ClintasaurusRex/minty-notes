import { hasMarkup, sizeAfterCrop, visibleRect } from '../../domain/markup'
import type { CanvasObject, ImageObject, Markup, SketchObject } from '../../domain/types'

/** Font used for labels, on the page, in the editor, and in PNG copies. */
export const LABEL_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'

/** Background of sketches (the page colour), also used in their PNG copies. */
export const SKETCH_BACKGROUND = '#141b1a'

let measureCtx: CanvasRenderingContext2D | null = null
/** Width of a (multi-line) label in markup units. */
export function measureLabel(text: string, size: number): number {
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (!measureCtx) return text.length * size * 0.58
  measureCtx.font = `${size}px ${LABEL_FONT}`
  return Math.max(1, ...text.split('\n').map((line) => measureCtx!.measureText(line).width))
}

/** Blur strength for a coordinate space (strong enough that small text is not readable on screen). */
export function blurRadius(m: { width: number; height: number }): number {
  return Math.max(6, Math.round(Math.min(m.width, m.height) / 110))
}

/** Natural size of an image (falls back to `fallback` when it cannot be decoded). */
export async function naturalSize(url: string | null, fallback: { width: number; height: number }): Promise<{ width: number; height: number }> {
  if (!url) return fallback
  const img = new Image()
  img.src = url
  try {
    await img.decode()
    if (img.naturalWidth > 0 && img.naturalHeight > 0) return { width: img.naturalWidth, height: img.naturalHeight }
  } catch {
    // Use the fallback below.
  }
  return fallback
}

/** The patch that saves an edited markup (an image keeps its display scale when the crop changes). */
export function markupPatch(obj: ImageObject | SketchObject, next: Markup, pageWidth: number): Partial<CanvasObject> {
  if (obj.type === 'sketch') return { markup: next }
  const before = obj.markup ? visibleRect(obj.markup) : { x: 0, y: 0, w: next.width, h: next.height }
  const after = visibleRect(next)
  const sameView = before.x === after.x && before.y === after.y && before.w === after.w && before.h === after.h
  const keep = obj.markup || hasMarkup(next) ? { markup: next } : {}
  return sameView ? keep : { ...keep, ...sizeAfterCrop(obj, before, after, pageWidth) }
}
