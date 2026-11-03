import { arrowHead, emptyMarkup, LABEL_LINE_HEIGHT, LABEL_PAD, REDACT_COLOR, visibleRect } from '../../domain/markup'
import type { Annotation, ImageObject, Markup, SketchObject } from '../../domain/types'
import { saveBytesAsDownload } from '../../platform/download'
import { notify } from '../notices'
import { blurRadius, LABEL_FONT, measureLabel, SKETCH_BACKGROUND } from './markupHelpers'

/** Largest side of an exported PNG (bigger markups are scaled down). */
const MAX_EXPORT_SIDE = 8192

async function decode(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
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

/**
 * Flatten an image (or sketch) and its markup into a new PNG. This is the
 * share-safe form: redaction boxes overwrite the pixels underneath with solid
 * black, blurred areas are pixelated and blurred, nothing outside the crop is
 * kept, and there are no layers. The stored original is not changed.
 */
export async function renderMarkupPng(markup: Markup, image: Blob | null, background: string | null): Promise<Blob> {
  const v = visibleRect(markup)
  const k = Math.min(1, MAX_EXPORT_SIDE / Math.max(v.w, v.h))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(v.w * k))
  canvas.height = Math.max(1, Math.round(v.h * k))
  const g = canvas.getContext('2d')
  if (!g) throw new Error('This browser cannot draw images.')
  g.scale(k, k)
  g.translate(-v.x, -v.y)
  if (background) {
    g.fillStyle = background
    g.fillRect(v.x, v.y, v.w, v.h)
  }
  const bitmap = image ? await decode(image) : null
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
  if (bitmap && 'close' in bitmap) bitmap.close()
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The PNG copy could not be created.'))), 'image/png'))
}

/** File name for an exported copy, e.g. "Screenshot 2026-11-03 (marked up).png". */
export function markedUpName(original: string): string {
  const base = original.replace(/\.[a-z0-9]{1,5}$/i, '') || 'image'
  return `${base} (marked up).png`
}

/** Download a flattened PNG of a marked-up image or sketch without opening the editor. */
export async function savePngCopy(obj: ImageObject | SketchObject, getBlob: (id: string) => Promise<Blob | undefined>, fileName: string): Promise<void> {
  try {
    const image = obj.type === 'image' ? ((await getBlob(obj.attachmentId)) ?? null) : null
    if (obj.type === 'image' && !image) throw new Error('the image file is missing')
    const markup = obj.markup ?? emptyMarkup(obj.w, obj.h)
    const blob = await renderMarkupPng(markup, image, obj.type === 'sketch' ? SKETCH_BACKGROUND : null)
    saveBytesAsDownload(new Uint8Array(await blob.arrayBuffer()), markedUpName(fileName), 'image/png')
    notify('success', 'Saved a flattened PNG copy. Redacted areas are solid black in that file; the original stays unchanged in Minty Notes.')
  } catch (err) {
    notify('error', `The PNG copy could not be made: ${err instanceof Error ? err.message : String(err)}`)
  }
}
