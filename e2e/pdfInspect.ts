import { inflateSync } from 'node:zlib'

/**
 * Independent checks of an exported PDF file, in Node. Two readers are used:
 * a small raw parser written for these tests (structure, cross-reference
 * table, every stream, and the decoded pixels of every image in the file —
 * referenced or not), and PDF.js (text, links, page sizes, metadata).
 */

export interface PdfImage {
  obj: number
  width: number
  height: number
  channels: number
  /** Decoded samples, row by row (no filter bytes). */
  pixels: Uint8Array
  filter: string
  isMask: boolean
}

export interface PdfTextItem {
  str: string
  x: number
  /** Baseline, from the top of the sheet. */
  y: number
  width: number
}

/** What a page draws, in drawing order (images by size; text as shown). */
export type PdfOp = { kind: 'image'; width: number; height: number } | { kind: 'text'; text: string }

export interface PdfReport {
  title: string
  pages: { width: number; height: number; text: string; items: PdfTextItem[]; ops: PdfOp[] }[]
  links: string[]
  images: PdfImage[]
  fonts: string[]
  /** The whole file as Latin-1 text (operators, dictionaries), with streams decompressed appended. */
  raw: string
  bytes: Uint8Array
}

function unfilterPng(data: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels
  const out = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const type = data[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const row = y * stride
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[row + i - channels] : 0
      const b = y > 0 ? out[row - stride + i] : 0
      const c = i >= channels && y > 0 ? out[row - stride + i - channels] : 0
      const x = data[src + i]
      let v: number
      if (type === 0) v = x
      else if (type === 1) v = x + a
      else if (type === 2) v = x + b
      else if (type === 3) v = x + ((a + b) >> 1)
      else {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
      }
      out[row + i] = v & 0xff
    }
  }
  return out
}

/** Check the cross-reference table: every entry must point at "N 0 obj". Throws on any mismatch. */
export function checkXref(bytes: Uint8Array): number {
  const text = Buffer.from(bytes).toString('latin1')
  if (!text.startsWith('%PDF-1.')) throw new Error('missing PDF header')
  if (!text.trimEnd().endsWith('%%EOF')) throw new Error('missing %%EOF')
  const sx = text.lastIndexOf('startxref')
  const xrefAt = parseInt(text.slice(sx + 9).trim(), 10)
  if (text.slice(xrefAt, xrefAt + 4) !== 'xref') throw new Error(`startxref ${xrefAt} does not point at the xref table`)
  const m = text.slice(xrefAt).match(/^xref\s+0\s+(\d+)\s+/)
  if (!m) throw new Error('unreadable xref table')
  const count = parseInt(m[1], 10)
  const entries = text.slice(xrefAt + m[0].length).split('\n').slice(0, count)
  for (let n = 1; n < count; n++) {
    const offset = parseInt(entries[n].slice(0, 10), 10)
    if (!text.startsWith(`${n} 0 obj`, offset)) throw new Error(`xref entry ${n} (offset ${offset}) does not point at object ${n}`)
  }
  return count - 1
}

function rawStreams(bytes: Uint8Array): { obj: number; dict: string; data: Uint8Array }[] {
  const text = Buffer.from(bytes).toString('latin1')
  const out: { obj: number; dict: string; data: Uint8Array }[] = []
  const re = /(\d+) 0 obj\s*<<([\s\S]*?)>>\s*stream\r?\n/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const dict = m[2]
    const len = dict.match(/\/Length (\d+)/)
    if (!len) throw new Error(`stream ${m[1]} has no length`)
    const start = m.index + m[0].length
    const data = bytes.subarray(start, start + parseInt(len[1], 10))
    if (!text.startsWith('\nendstream', start + data.length)) throw new Error(`stream ${m[1]} length is wrong`)
    out.push({ obj: parseInt(m[1], 10), dict, data: dict.includes('/FlateDecode') ? new Uint8Array(inflateSync(data)) : data })
    re.lastIndex = start + data.length
  }
  return out
}

export async function inspectPdf(bytes: Uint8Array): Promise<PdfReport> {
  checkXref(bytes)
  const streams = rawStreams(bytes)
  const images: PdfImage[] = []
  for (const s of streams) {
    if (!s.dict.includes('/Subtype /Image')) continue
    const width = parseInt(s.dict.match(/\/Width (\d+)/)![1], 10)
    const height = parseInt(s.dict.match(/\/Height (\d+)/)![1], 10)
    const channels = s.dict.includes('/DeviceGray') ? 1 : 3
    const filter = s.dict.includes('/DCTDecode') ? 'DCT' : 'Flate'
    const pixels = filter === 'Flate' && s.dict.includes('/Predictor 15') ? unfilterPng(s.data, width, height, channels) : s.data
    images.push({ obj: s.obj, width, height, channels, pixels, filter, isMask: channels === 1 })
  }
  const latin = Buffer.from(bytes).toString('latin1')
  const raw = latin + streams.map((s) => Buffer.from(s.data).toString('latin1')).join('\n')
  const fonts = [...latin.matchAll(/\/FontName \/([A-Z]{6}\+[A-Za-z0-9-]+)/g)].map((m) => m[1])

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data: bytes.slice(), useWorkerFetch: false, stopAtErrors: true })
  const doc = await task.promise
  const meta = await doc.getMetadata()
  const pages: PdfReport['pages'] = []
  const links: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i)
    const vp = p.getViewport({ scale: 1 })
    const tc = await p.getTextContent()
    const text = tc.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join('')
    const items: PdfTextItem[] = []
    for (const it of tc.items) if ('str' in it && it.str.trim()) items.push({ str: it.str, x: it.transform[4], y: vp.height - it.transform[5], width: it.width })
    const list = await p.getOperatorList()
    const ops: PdfOp[] = []
    for (let k = 0; k < list.fnArray.length; k++) {
      const fn = list.fnArray[k]
      const args = list.argsArray[k] as unknown[]
      if (fn === pdfjs.OPS.paintImageXObject) {
        const img = (await new Promise((resolve) => p.objs.get(args[0] as string, resolve))) as { width: number; height: number }
        ops.push({ kind: 'image', width: img.width, height: img.height })
      } else if (fn === pdfjs.OPS.showText) {
        const glyphs = args[0] as ({ unicode?: string } | number | null)[]
        ops.push({ kind: 'text', text: glyphs.map((g) => (g && typeof g === 'object' ? (g.unicode ?? '') : '')).join('') })
      }
    }
    pages.push({ width: vp.width, height: vp.height, text, items, ops })
    for (const a of await p.getAnnotations()) if (a.subtype === 'Link' && a.url) links.push(a.url)
  }
  await task.destroy()
  return { title: (meta.info as { Title?: string }).Title ?? '', pages, links, images, fonts, raw, bytes }
}

/** Count pixels close to a colour in an RGB image. */
export function countColor(img: PdfImage, [r, g, b]: [number, number, number], tolerance = 40): number {
  if (img.channels !== 3 || img.filter !== 'Flate') return 0
  let n = 0
  for (let i = 0; i < img.pixels.length; i += 3) if (Math.abs(img.pixels[i] - r) <= tolerance && Math.abs(img.pixels[i + 1] - g) <= tolerance && Math.abs(img.pixels[i + 2] - b) <= tolerance) n++
  return n
}

export function pixelAt(img: PdfImage, x: number, y: number): [number, number, number] {
  const i = (y * img.width + x) * img.channels
  return [img.pixels[i], img.pixels[i + 1], img.pixels[i + 2]]
}

/** True when `needle` occurs anywhere in `hay`. */
export function containsBytes(hay: Uint8Array, needle: Uint8Array): boolean {
  return Buffer.from(hay).indexOf(Buffer.from(needle)) >= 0
}
