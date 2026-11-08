import { emptyMarkup, hasMarkup, SKETCH_BACKGROUND, visibleRect } from '../domain/markup'
import { pageLinkIds } from '../domain/pageLink'
import type { AttachmentMeta, CanvasObject, Page } from '../domain/types'
import { fontFileFor, loadFont } from './fonts'
import { createLayoutHost, layoutNote, measureTitleBlock, textLines, type FontKey, type LaidPicture, type LaidRun, type LaidText, type Rgba } from './layoutNote'
import { chooseSheet, FOOTER_BAND, MARGIN, PT_PER_PX, type Orientation, type Paper, type Sheet } from './layoutRules'
import { decodeImage, renderMarkupCanvas } from './markupRaster'
import { bandOf, paginate, type Band, type Interval } from './paginate'
import { PdfWriter, type PdfImageData, type PdfPage, type Rgb } from './pdfWriter'

/**
 * Note-to-PDF export. The note is laid out by the browser (same CSS and line
 * breaks as on screen), split into sheets at clean places, and written as a
 * PDF with real, selectable text. Pictures are always flattened first: the
 * PDF contains only the pixels of the visible, marked-up result, with
 * redacted areas solid black — never the stored original file. Nothing in the
 * workspace is changed.
 */

export interface NotePdfOptions {
  paper: Paper
  orientation: Orientation
  theme: 'light' | 'dark'
}

export interface NotePdfInput {
  page: Page
  objects: CanvasObject[]
  /** Where the note lives, e.g. "Inbox" or "Lift station › Notes". */
  location: string
  attachments: Record<string, AttachmentMeta>
  getBlob: (id: string) => Promise<Blob | undefined>
  appVersion: string
  now?: Date
}

export interface NotePdfResult {
  bytes: Uint8Array
  pageCount: number
  sheet: Sheet
  /** Size of ordinary note text (16 px) in the PDF, in points. */
  bodyPt: number
  redactions: number
  blurs: number
  /** Plain-language notes about the export (scaling, splits, flattening). */
  notes: string[]
}

/** Print resolution for pictures (pixels per inch at their printed size). */
const PICTURE_DPI = 200
/** Resolution of words drawn as pictures (characters the embedded fonts lack). */
const GLYPH_DPI = 300
const TITLE_GAP = 14

const rgb = (c: Rgba): Rgb => [c.r / 255, c.g / 255, c.b / 255]

/**
 * Scripts that need shaping or right-to-left ordering (Hebrew, Arabic, Syriac,
 * Thaana, N'Ko, Indic, Thai, Lao, Tibetan, Myanmar, Khmer, Mongolian, and
 * presentation forms). The PDF writer places glyphs left to right without
 * shaping, so such words are drawn as pictures by the browser instead.
 */
const NEEDS_SHAPING = /[\u0590-\u08ff\u0900-\u0fff\u1000-\u109f\u1780-\u18af\ufb1d-\ufdff\ufe70-\ufeff]/u
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function pixelsOf(canvas: HTMLCanvasElement, sy: number, sh: number): { rgb: Uint8Array; alpha: Uint8Array | null } {
  const g = canvas.getContext('2d')!
  const data = g.getImageData(0, sy, canvas.width, sh).data
  const n = canvas.width * sh
  const out = new Uint8Array(n * 3)
  const alpha = new Uint8Array(n)
  let opaque = true
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i * 3] = data[j]
    out[i * 3 + 1] = data[j + 1]
    out[i * 3 + 2] = data[j + 2]
    alpha[i] = data[j + 3]
    if (data[j + 3] !== 255) opaque = false
  }
  return { rgb: out, alpha: opaque ? null : alpha }
}

async function jpegOf(canvas: HTMLCanvasElement, sy: number, sh: number): Promise<Uint8Array> {
  const piece = document.createElement('canvas')
  piece.width = canvas.width
  piece.height = sh
  piece.getContext('2d')!.drawImage(canvas, 0, sy, canvas.width, sh, 0, 0, canvas.width, sh)
  const blob = await new Promise<Blob | null>((r) => piece.toBlob(r, 'image/jpeg', 0.9))
  piece.width = 0
  if (!blob) throw new Error('a picture could not be compressed')
  return new Uint8Array(await blob.arrayBuffer())
}

/** A word in characters the embedded font lacks (emoji, some scripts), drawn with the browser's fonts. */
function rasterWord(text: string, run: LaidRun, w: number, k: number): { data: PdfImageData; pad: number; h: number } {
  const pad = run.size * 0.25
  const h = run.bottom - run.top + pad * 2
  const density = (k * GLYPH_DPI) / 72
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil((w + pad) * density))
  canvas.height = Math.max(1, Math.ceil(h * density))
  const g = canvas.getContext('2d')!
  g.scale(density, density)
  g.font = run.cssFont
  g.fillStyle = `rgba(${run.color.r}, ${run.color.g}, ${run.color.b}, ${run.color.a})`
  g.textBaseline = 'alphabetic'
  g.fillText(text, 0, run.baseline - run.top + pad)
  const { rgb, alpha } = pixelsOf(canvas, 0, canvas.height)
  const data: PdfImageData = { kind: 'raw', width: canvas.width, height: canvas.height, rgb, alpha: alpha ?? new Uint8Array(canvas.width * canvas.height).fill(255) }
  canvas.width = 0
  return { data, pad, h }
}

interface Slice {
  band: number
  name: string | null
  /** Canvas-space top and height of this piece. */
  top: number
  height: number
}

/** Flatten one picture and cut it into the pieces that fall on each sheet. */
async function pictureSlices(o: LaidPicture, bands: Band[], k: number, input: NotePdfInput, writer: PdfWriter, counts: { redactions: number; blurs: number; missing: number; unreadable: number; split: number }): Promise<Slice[]> {
  const obj = o.object
  const bandsHit = bands.map((b, i) => ({ b, i })).filter(({ b }) => o.y < b.end && o.y + o.h > b.start)
  if (bandsHit.length === 0) return []
  const targetPx = (obj.w * k * PICTURE_DPI) / 72
  let canvas: HTMLCanvasElement
  let jpeg = false
  if (obj.type === 'sketch') {
    const v = visibleRect(obj.markup)
    canvas = await renderMarkupCanvas(obj.markup, null, SKETCH_BACKGROUND, { scale: Math.min(4, Math.max(1, targetPx / v.w)) })
  } else {
    const blob = await input.getBlob(obj.attachmentId)
    const placeholder = () => bandsHit.map(({ b, i }) => ({ band: i, name: null, top: Math.max(o.y, b.start), height: Math.min(o.y + o.h, b.end) - Math.max(o.y, b.start) }))
    if (!blob) {
      counts.missing++
      return placeholder()
    }
    let bitmap: ImageBitmap | HTMLImageElement
    try {
      bitmap = await decodeImage(blob)
    } catch {
      counts.unreadable++
      return placeholder()
    }
    try {
      const natW = 'naturalWidth' in bitmap ? bitmap.naturalWidth : bitmap.width
      const natH = 'naturalHeight' in bitmap ? bitmap.naturalHeight : bitmap.height
      const meta = input.attachments[obj.attachmentId]
      const svg = blob.type === 'image/svg+xml'
      const markup = obj.markup ?? emptyMarkup(natW || meta?.width || obj.w, natH || meta?.height || obj.h)
      counts.redactions += markup.items.filter((a) => a.kind === 'redact').length
      counts.blurs += markup.items.filter((a) => a.kind === 'blur').length
      const v = visibleRect(markup)
      // Never enlarge a bitmap beyond its own pixels (vector images may be drawn sharper).
      const scale = svg ? Math.min(4, targetPx / v.w) : Math.min(1, targetPx / v.w)
      canvas = await renderMarkupCanvas(markup, bitmap, null, { scale })
      jpeg = (meta?.mimeType ?? blob.type) === 'image/jpeg' && !hasMarkup(obj.markup)
    } finally {
      if ('close' in bitmap) bitmap.close()
    }
  }
  if (bandsHit.length > 1) counts.split++
  const slices: Slice[] = []
  try {
    const perPx = canvas.height / o.h
    for (const { b, i } of bandsHit) {
      const top = Math.max(o.y, b.start)
      const bottom = Math.min(o.y + o.h, b.end)
      const sy = Math.max(0, Math.min(canvas.height - 1, Math.round((top - o.y) * perPx)))
      const ey = Math.max(sy + 1, Math.min(canvas.height, Math.round((bottom - o.y) * perPx)))
      const sh = ey - sy
      let name: string
      if (jpeg) name = writer.addImage({ kind: 'jpeg', width: canvas.width, height: sh, jpeg: await jpegOf(canvas, sy, sh) })
      else {
        const px = pixelsOf(canvas, sy, sh)
        name = await writer.addImageAsync({ kind: 'raw', width: canvas.width, height: sh, rgb: px.rgb, alpha: px.alpha })
      }
      slices.push({ band: i, name, top, height: bottom - top })
    }
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
  return slices
}

function drawRun(page: PdfPage, writer: PdfWriter, run: LaidRun, map: { x: (v: number) => number; y: (v: number) => number; k: number }, counts: { rasterWords: number }): void {
  const words = []
  for (const w of run.words) {
    if (writer.covers(run.font, w.text) && !NEEDS_SHAPING.test(w.text)) {
      words.push({ text: w.text, x: map.x(w.x), w: w.w * map.k, before: w.before })
      continue
    }
    counts.rasterWords++
    const img = rasterWord(w.raw, run, w.w, map.k)
    const name = writer.addImage(img.data)
    page.image(name, map.x(w.x), map.y(run.top - img.pad), (w.w + img.pad) * map.k, img.h * map.k)
  }
  if (words.length) page.text({ font: run.font, size: run.size * map.k, color: rgb(run.color), opacity: run.color.a, baseline: map.y(run.baseline), words })
  for (const d of run.decorations) {
    const width = d.width * map.k
    page.line(map.x(d.x1), map.y(d.y), map.x(d.x2), map.y(d.y), width, rgb(d.color), d.dotted ? [width, width * 1.5] : null, d.color.a)
  }
}

const FOOTER_COLOR: Record<NotePdfOptions['theme'], Rgb> = { light: [0.42, 0.47, 0.46], dark: [0.6, 0.66, 0.64] }
const PAGE_COLOR: Rgb = [0x14 / 255, 0x1b / 255, 0x1a / 255]

export async function buildNotePdf(input: NotePdfInput, options: NotePdfOptions, onProgress?: (message: string) => void): Promise<NotePdfResult> {
  const now = input.now ?? new Date()
  const title = input.page.title.trim() || 'Untitled page'
  onProgress?.('Laying out the note…')
  const host = createLayoutHost(options.theme)
  let layout: ReturnType<typeof layoutNote>
  let sheet: Sheet
  let titleBlock: ReturnType<typeof measureTitleBlock>
  try {
    layout = layoutNote(input.objects, host)
    sheet = chooseSheet(options.paper, options.orientation, Math.max(1, layout.right - layout.left))
    const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(now)
    titleBlock = measureTitleBlock(host, title, `${input.location} · exported ${when} from Minty Notes`, (sheet.width - 2 * MARGIN) / PT_PER_PX)
  } finally {
    host.dispose()
  }
  const k = sheet.scale * PT_PER_PX
  const texts = layout.objects.filter((o): o is LaidText => o.kind === 'text')
  const pictures = layout.objects.filter((o): o is LaidPicture => o.kind === 'picture')

  // Fonts actually used.
  onProgress?.('Preparing fonts…')
  const writer = new PdfWriter({ title, producer: `Minty Notes ${input.appVersion}`, creationDate: now, lang: document.documentElement.lang || navigator.language || 'en' })
  const keys = new Set<FontKey>(['sans'])
  for (const t of texts) for (const r of t.runs) keys.add(r.font)
  for (const r of titleBlock.content.runs) keys.add(r.font)
  for (const key of keys) {
    const { file, fakeItalic } = fontFileFor(key)
    writer.addFont(key, await loadFont(file), { fakeItalic })
  }

  // Page breaks.
  const titlePt = titleBlock.height * PT_PER_PX
  const firstTop = MARGIN + titlePt + TITLE_GAP
  const bottomLimit = sheet.height - MARGIN - FOOTER_BAND
  const items: Interval[] = []
  for (const t of texts) {
    for (const r of t.runs) items.push(r)
    for (const r of [...t.rects, ...t.strokes]) items.push({ top: r.y, bottom: r.y + r.h })
  }
  for (const p of pictures) items.push({ top: p.y, bottom: p.y + p.h })
  const bands = paginate({
    firstHeight: (bottomLimit - firstTop) / k,
    height: (bottomLimit - MARGIN) / k,
    items,
    lines: texts.flatMap(textLines),
    solids: pictures.map((p) => ({ top: p.y, bottom: p.y + p.h })),
    objects: layout.objects.map((o) => ({ top: o.y, bottom: o.y + o.h })),
    rows: texts.flatMap((t) => t.rows),
    blocks: texts.flatMap((t) => t.blocks),
  })
  const sheets = Math.max(1, bands.length)

  // Pictures: flattened, then cut per sheet.
  const counts = { redactions: 0, blurs: 0, missing: 0, unreadable: 0, split: 0, rasterWords: 0 }
  const slices = new Map<string, Slice[]>()
  for (let i = 0; i < pictures.length; i++) {
    onProgress?.(`Flattening pictures (${i + 1} of ${pictures.length})…`)
    slices.set(pictures[i].object.id, await pictureSlices(pictures[i], bands, k, input, writer, counts))
  }

  onProgress?.('Writing the PDF…')
  const footerColor = FOOTER_COLOR[options.theme]
  for (let i = 0; i < sheets; i++) {
    const page = writer.addPage(sheet.width, sheet.height)
    if (options.theme === 'dark') page.fillRect(0, 0, sheet.width, sheet.height, PAGE_COLOR)
    const band = bands[i] ?? { start: 0, end: 0, forced: false }
    const top = i === 0 ? firstTop : MARGIN
    const map = { x: (v: number) => MARGIN + (v - layout.left) * k, y: (v: number) => top + (v - band.start) * k, k }
    if (i === 0) {
      const tmap = { x: (v: number) => MARGIN + v * PT_PER_PX, y: (v: number) => MARGIN + v * PT_PER_PX, k: PT_PER_PX }
      for (const r of titleBlock.content.runs) drawRun(page, writer, r, tmap, counts)
      page.line(MARGIN, MARGIN + titlePt + TITLE_GAP / 2, sheet.width - MARGIN, MARGIN + titlePt + TITLE_GAP / 2, 0.75, footerColor, null, 0.5)
      if (bands.length === 0) page.plainText('sans', 10, footerColor, MARGIN, firstTop + 14, 'This page is empty.')
    }
    if (bands[i]) {
      const bandH = (band.end - band.start) * k
      for (const o of layout.objects) {
        if (o.kind === 'picture') {
          for (const s of slices.get(o.object.id) ?? []) {
            if (s.band !== i) continue
            const x = map.x(o.object.x)
            const y = map.y(s.top)
            if (s.name) page.image(s.name, x, y, o.object.w * k, s.height * k)
            else {
              page.strokeRoundRect(x, y, o.object.w * k, s.height * k, 2, 0.75, footerColor)
              page.plainText('sans', 9, footerColor, x + 6, y + Math.min(14, s.height * k - 3), 'Image not available')
            }
          }
          continue
        }
        // Backgrounds and borders: only the part on this sheet.
        const shapes = [...o.rects, ...o.strokes].filter((r) => r.y < band.end && r.y + r.h > band.start)
        if (shapes.length) {
          page.clipBand(top, bandH)
          for (const r of o.rects) {
            if (r.y >= band.end || r.y + r.h <= band.start) continue
            page.fillRoundRect(map.x(r.x), map.y(r.y), r.w * k, r.h * k, r.radius * k, rgb(r.color), r.color.a)
          }
          for (const s of o.strokes) {
            if (s.y >= band.end || s.y + s.h <= band.start) continue
            page.strokeRoundRect(map.x(s.x), map.y(s.y), s.w * k, s.h * k, s.radius * k, s.width * k, rgb(s.color), s.color.a)
          }
          page.endClip()
        }
        for (const r of o.runs) if (bandOf(bands, r) === i) drawRun(page, writer, r, map, counts)
        for (const l of o.links) if (bandOf(bands, { top: l.y, bottom: l.y + l.h }) === i) page.link(map.x(l.x), map.y(l.y), l.w * k, l.h * k, l.href)
      }
    }
    // Footer: page number, and the title when the font can show it.
    const label = `Page ${i + 1} of ${sheets}`
    const fy = sheet.height - MARGIN + 6
    const lw = page.measure('sans', 8, label)
    page.plainText('sans', 8, footerColor, sheet.width - MARGIN - lw, fy, label)
    if (writer.covers('sans', title)) {
      let t = title
      const room = sheet.width - 2 * MARGIN - lw - 24
      while (t.length > 1 && page.measure('sans', 8, t) > room) t = [...t].slice(0, -2).join('')
      if (t !== title) t = `${t.trimEnd()}…`
      page.plainText('sans', 8, footerColor, MARGIN, fy, t)
    }
  }

  const bytes = writer.finish()

  const notes: string[] = []
  const bodyPt = Math.round(16 * k * 2) / 2
  notes.push(`${plural(sheets, 'page')} on ${options.paper === 'a4' ? 'A4' : 'Letter'} paper, ${sheet.orientation}. Ordinary text is about ${bodyPt} pt.`)
  if (sheet.scale < 0.999) notes.push(`The note is wider than the printable area, so everything is shown at ${Math.round(sheet.scale * 100)} % of its size on screen (nothing is cut off).`)
  if (options.orientation === 'auto' && sheet.orientation === 'landscape') notes.push('Landscape was chosen automatically so the text stays readable.')
  if (sheet.orientation === 'portrait' && sheet.scale < 0.78) notes.push('Text is small in portrait; choose Landscape for larger text.')
  if (layout.wideBoxes) notes.push(`${plural(layout.wideBoxes, 'text box', 'text boxes')} ${layout.wideBoxes === 1 ? 'contains' : 'contain'} a table wider than the box; it is shown in full and the page is scaled to fit it.`)
  if (layout.grownBoxes) notes.push(`${plural(layout.grownBoxes, 'text box', 'text boxes')} needed a little more room than on screen; what was below ${layout.grownBoxes === 1 ? 'it' : 'them'} moved down so nothing is covered.`)
  if (counts.redactions) notes.push(`${plural(counts.redactions, 'redaction box', 'redaction boxes')}: the covered pixels are replaced with solid black in the PDF (the original image in Minty Notes is unchanged).`)
  if (counts.blurs) notes.push(`${plural(counts.blurs, 'blurred area')} ${counts.blurs === 1 ? 'is' : 'are'} pixelated in the PDF. Blur is not a secure redaction — use a redaction box for passwords and other secrets.`)
  if (counts.split) notes.push(`${plural(counts.split, 'picture')} taller than the space on a sheet ${counts.split === 1 ? 'is' : 'are'} split across sheets.`)
  if (bands.length > 1 && bands[0].end === bands[0].start) notes.push('The first picture does not fit below the title, so it starts on page 2 (it is not split).')
  const forced = bands.filter((b) => b.forced).length
  if (forced) notes.push(`${plural(forced, 'page break')} could not avoid content (for example text boxes side by side); text lines are kept whole on the next sheet.`)
  if (counts.rasterWords) notes.push(`${plural(counts.rasterWords, 'word')} use characters the PDF font does not include, or a script it cannot shape (for example emoji, Arabic, or Hebrew); ${counts.rasterWords === 1 ? 'it is' : 'they are'} drawn as pictures and cannot be searched or copied.`)
  if (counts.unreadable) notes.push(`${plural(counts.unreadable, 'image file')} could not be read (damaged or in an unsupported format) and ${counts.unreadable === 1 ? 'is' : 'are'} shown as a placeholder.`)
  if (counts.missing) notes.push(`${plural(counts.missing, 'image file')} ${counts.missing === 1 ? 'is' : 'are'} missing from this workspace and shown as a placeholder.`)
  const links = new Set(texts.flatMap((t) => pageLinkIds(t.object.doc))).size
  if (links) notes.push('Links to other Minty Notes pages are kept as styled text; they only open inside Minty Notes. Web links stay clickable.')
  if (input.page.importedFrom) notes.push(`This is the editable draft of “${input.page.importedFrom.fileName}”; the original file is not included in the PDF.`)
  return { bytes, pageCount: sheets, sheet, bodyPt, redactions: counts.redactions, blurs: counts.blurs, notes }
}
