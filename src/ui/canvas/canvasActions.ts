import { sha256Hex } from '../../backup/archive'
import { clampRect, findFreeSpot, PAGE_MARGIN, PLACEMENT_GAP, type Rect } from '../../domain/geometry'
import { newId, nowIso, type AttachmentMeta, type CanvasObject } from '../../domain/types'

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

function readImageSize(blob: Blob): Promise<{ width: number; height: number } | null> {
  const url = URL.createObjectURL(blob)
  const img = new Image()
  img.src = url
  return img
    .decode()
    .then(() => (img.naturalWidth > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null))
    .catch(() => null)
    .finally(() => URL.revokeObjectURL(url))
}

function screenshotName(file: Blob & { name?: string }, type: string): string {
  const name = file.name && file.name !== 'image.png' ? file.name : ''
  if (name) return name
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.')
  const ext = type.split('/')[1]?.replace('svg+xml', 'svg').replace('jpeg', 'jpg') ?? 'png'
  return `Screenshot ${stamp}.${ext}`
}

/** Read an image into an attachment record plus its bytes. Throws if it cannot be decoded. */
export async function prepareImage(file: Blob & { name?: string }, source: AttachmentMeta['source']): Promise<{ meta: AttachmentMeta; blob: Blob }> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const size = await readImageSize(file)
  if (!size && file.type !== 'image/svg+xml') throw new Error('The image could not be read.')
  const blob = new Blob([bytes], { type: file.type })
  const meta: AttachmentMeta = {
    id: newId(),
    fileName: screenshotName(file, file.type),
    mimeType: file.type,
    size: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    width: size?.width ?? null,
    height: size?.height ?? null,
    source,
    createdAt: nowIso(),
  }
  return { meta, blob }
}
