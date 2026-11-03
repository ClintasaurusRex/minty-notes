import { clampRect, findFreeSpot, PAGE_MARGIN, PLACEMENT_GAP, type Rect } from '../../domain/geometry'
import type { CanvasObject } from '../../domain/types'

export const DEFAULT_TEXT_WIDTH = 600
export const NEW_TEXT_HEIGHT = 40

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif', 'image/svg+xml'])

export function isSupportedImage(file: { type: string }): boolean {
  return IMAGE_TYPES.has(file.type)
}

/** Image files from a paste or drop, in order. */
export function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return []
  const files: File[] = []
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file') {
      const f = item.getAsFile()
      if (f && isSupportedImage(f)) files.push(f)
    }
  }
  if (files.length === 0) for (const f of Array.from(data.files ?? [])) if (isSupportedImage(f)) files.push(f)
  return files
}

export function nextZ(objects: CanvasObject[]): number {
  return objects.reduce((max, o) => Math.max(max, o.z), 0) + 1
}

export function minZ(objects: CanvasObject[]): number {
  return objects.reduce((min, o) => Math.min(min, o.z), Number.POSITIVE_INFINITY)
}

export interface PlacementContext {
  objects: CanvasObject[]
  pageWidth: number
  /** Object the new content relates to (selected or being edited). */
  anchor: CanvasObject | null
  /** Top of the visible part of the page, in page coordinates. */
  viewportTop: number
}

/**
 * Placement rule for new objects: an explicit point (drop or double-click)
 * is used as-is; otherwise below the anchor object, or near the top of the
 * visible area, moving down past existing content so nothing is covered.
 */
export function placeNew(size: { w: number; h: number }, ctx: PlacementContext, at?: { x: number; y: number }): Rect {
  if (at) return clampRect({ x: at.x, y: at.y, ...size }, ctx.pageWidth, 1, 1)
  const desired = ctx.anchor
    ? { x: ctx.anchor.x, y: ctx.anchor.y + ctx.anchor.h + PLACEMENT_GAP, ...size }
    : { x: PAGE_MARGIN, y: Math.max(PAGE_MARGIN, ctx.viewportTop + PAGE_MARGIN), ...size }
  return findFreeSpot(desired, ctx.objects, ctx.pageWidth)
}

export { prepareImage } from '../../platform/images'
