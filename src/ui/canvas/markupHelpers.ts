import { hasMarkup, sizeAfterCrop, visibleRect } from '../../domain/markup'
import type { CanvasObject, ImageObject, Markup, SketchObject } from '../../domain/types'

export { blurRadius, LABEL_FONT, SKETCH_BACKGROUND } from '../../domain/markup'
export { measureLabel } from '../../export/markupRaster'

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
