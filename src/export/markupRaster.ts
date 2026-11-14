import { arrowHead, blurRadius, LABEL_FONT, LABEL_LINE_HEIGHT, LABEL_PAD, REDACT_COLOR, visibleRect } from '../domain/markup'
import type { Annotation, Markup } from '../domain/types'

/**
 * Flattening of an image (or sketch) and its markup into plain pixels — the
 * share-safe form used by "Save PNG copy" and by note-to-PDF export. Redaction
 * boxes overwrite the pixels underneath with solid black, blurred areas are
 * pixelated and blurred, nothing outside the crop is drawn, and the result has
 * no layers. The stored original is never changed. (Browser canvas; no React.)
 */

/** Largest side of a flattened image (bigger markups are scaled down). */
export const MAX_FLAT_SIDE = 8192

let measureCtx: CanvasRenderingContext2D | null = null
/** Width of a (multi-line) label in markup units. */
export function measureLabel(text: string, size: number): number {
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (!measureCtx) return text.length * size * 0.58
  measureCtx.font = `${size}px ${LABEL_FONT}`
  return Math.max(1, ...text.split('\n').map((line) => measureCtx!.measureText(line).width))
}

/** Decode stored image bytes for drawing. */
export async function decodeImage(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function' && blob.type !== 'image/svg+xml') return createImageBitmap(blob)
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return img
  } finally {
    URL.revokeObjectURL(url)
  }
}

function drawItem(g: CanvasRenderingContext2D, a: Annotation): void {
  g.save()
  switch (a.kind) {
    case 'arrow':
    case 'line': {
      g.strokeStyle = a.color
      g.fillStyle = a.color
      g.lineWidth = a.width
      g.lineCap = 'round'
      const len = Math.hypot(a.x2 - a.x1, a.y2 - a.y1) || 1
      const back = a.kind === 'arrow' ? Math.min(Math.max(10, a.width * 4) * 0.6, len) : 0
      g.beginPath()
      g.moveTo(a.x1, a.y1)
      g.lineTo(a.x2 - ((a.x2 - a.x1) / len) * back, a.y2 - ((a.y2 - a.y1) / len) * back)
      g.stroke()
      if (a.kind === 'arrow') {
        const head = arrowHead(a.x1, a.y1, a.x2, a.y2, a.width)
        g.beginPath()
        g.moveTo(head[0][0], head[0][1])
        g.lineTo(head[1][0], head[1][1])
        g.lineTo(head[2][0], head[2][1])
        g.closePath()
        g.fill()
      }
      break
    }
    case 'rect':
    case 'ellipse': {
      g.beginPath()
      if (a.kind === 'rect') g.roundRect(a.x, a.y, a.w, a.h, Math.min(a.width, 6))
      else g.ellipse(a.x + a.w / 2, a.y + a.h / 2, a.w / 2, a.h / 2, 0, 0, Math.PI * 2)
      if (a.fill) {
        g.fillStyle = a.fill
        g.fill()
      }
      if (a.width > 0) {
        g.strokeStyle = a.color
        g.lineWidth = a.width
        g.stroke()
      }
      break
    }
    case 'text': {
      const lines = a.text.split('\n')
      const pad = a.size * LABEL_PAD
      if (a.background) {
        g.fillStyle = a.background
        g.beginPath()
        g.roundRect(a.x - pad, a.y - pad, measureLabel(a.text, a.size) + pad * 2, lines.length * a.size * LABEL_LINE_HEIGHT + pad * 2, pad)
        g.fill()
      }
      g.fillStyle = a.color
      g.font = `${a.size}px ${LABEL_FONT}`
      g.textBaseline = 'hanging'
      lines.forEach((line, i) => g.fillText(line, a.x, a.y + i * a.size * LABEL_LINE_HEIGHT))
      break
    }
    case 'pen':
    case 'highlighter': {
      g.strokeStyle = a.color
      g.lineWidth = a.width
      g.globalAlpha = a.kind === 'highlighter' ? 0.38 : 1
      g.lineCap = a.kind === 'highlighter' ? 'square' : 'round'
      g.lineJoin = 'round'
      g.beginPath()
      g.moveTo(a.points[0], a.points[1])
      for (let i = 2; i < a.points.length; i += 2) g.lineTo(a.points[i], a.points[i + 1])
      if (a.points.length === 2) g.lineTo(a.points[0] + 0.01, a.points[1])
      g.stroke()
      break
    }
    case 'redact':
      g.fillStyle = REDACT_COLOR
      g.fillRect(a.x, a.y, a.w, a.h)
      break
    case 'blur':
      break
  }
  g.restore()
}

export interface FlattenOptions {
  /** Output pixels per markup unit (1 = natural size). Capped so no side exceeds MAX_FLAT_SIDE. */
  scale?: number
}

/**
 * Draw the visible part of `markup` over `image` (or over `background` for a
 * sketch) into a new canvas. Only the result's pixels leave this function.
 */
export async function renderMarkupCanvas(markup: Markup, image: Blob | ImageBitmap | HTMLImageElement | null, background: string | null, options: FlattenOptions = {}): Promise<HTMLCanvasElement> {
  const v = visibleRect(markup)
  const k = Math.min(options.scale ?? 1, MAX_FLAT_SIDE / Math.max(v.w, v.h))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(v.w * k))
  canvas.height = Math.max(1, Math.round(v.h * k))
  const g = canvas.getContext('2d')
  if (!g) throw new Error('This browser cannot draw images.')
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  g.scale(k, k)
  g.translate(-v.x, -v.y)
  if (background) {
    g.fillStyle = background
    g.fillRect(v.x, v.y, v.w, v.h)
  }
  const owned = image instanceof Blob
  const bitmap = image instanceof Blob ? await decodeImage(image) : image
  if (bitmap) g.drawImage(bitmap, 0, 0, markup.width, markup.height)

  const areas = markup.items.filter((a) => a.kind === 'blur' || a.kind === 'redact')
  const r = blurRadius(markup)
  for (const a of areas) {
    if (a.kind !== 'blur' || !bitmap || a.w < 1 || a.h < 1) continue
    // Pixelate (average blocks), then soften: the area's detail is not in the output.
    const block = Math.max(4, r * 1.5)
    const small = document.createElement('canvas')
    small.width = Math.max(1, Math.round(a.w / block))
    small.height = Math.max(1, Math.round(a.h / block))
    const sg = small.getContext('2d')!
    sg.imageSmoothingEnabled = true
    sg.imageSmoothingQuality = 'high'
    const sx = markup.width / ('naturalWidth' in bitmap ? bitmap.naturalWidth || markup.width : bitmap.width)
    const sy = markup.height / ('naturalHeight' in bitmap ? bitmap.naturalHeight || markup.height : bitmap.height)
    sg.drawImage(bitmap, a.x / sx, a.y / sy, a.w / sx, a.h / sy, 0, 0, small.width, small.height)
    g.save()
    g.beginPath()
    g.rect(a.x, a.y, a.w, a.h)
    g.clip()
    g.imageSmoothingEnabled = true
    // An opaque, smoothly enlarged copy first (so no original pixel shows at the
    // edges), then a blurred one on top.
    g.drawImage(small, a.x, a.y, a.w, a.h)
    g.filter = `blur(${Math.max(2, Math.round((r * k) / 2))}px)`
    g.drawImage(small, a.x, a.y, a.w, a.h)
    g.restore()
  }
  for (const a of areas) if (a.kind === 'redact') drawItem(g, a)
  for (const a of markup.items) if (a.kind !== 'blur' && a.kind !== 'redact') drawItem(g, a)
  if (owned && bitmap && 'close' in bitmap) bitmap.close()
  return canvas
}

/** The flattened image as a PNG file (see `renderMarkupCanvas`). */
export async function renderMarkupPng(markup: Markup, image: Blob | null, background: string | null): Promise<Blob> {
  const canvas = await renderMarkupCanvas(markup, image, background)
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The PNG copy could not be created.'))), 'image/png'))
}
