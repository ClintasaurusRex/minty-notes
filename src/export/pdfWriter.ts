import { zlib, zlibSync } from 'fflate'
import { subsetTrueType, type TrueTypeFont } from './trueType'

/**
 * A small PDF 1.7 writer for note exports. Pure (no DOM): it takes already
 * laid-out text runs, rectangles, lines, raster images, and links, and writes
 * a complete file with embedded, subsetted TrueType fonts (real, selectable
 * text), compressed streams, and a correct cross-reference table.
 *
 * Images are only ever written from pixel arrays (or JPEG bytes) that the
 * caller produced; nothing else is embedded. Coordinates are in points with
 * the origin at the top-left of the sheet (converted to PDF's bottom-left).
 */

export type Rgb = readonly [number, number, number]

export type PdfImageData =
  | { kind: 'raw'; width: number; height: number; rgb: Uint8Array; alpha?: Uint8Array | null }
  | { kind: 'jpeg'; width: number; height: number; jpeg: Uint8Array }

export interface PdfWord {
  text: string
  /** Left edge and width the word must occupy, in points. */
  x: number
  w: number
  /** Whitespace before the word on the same line (written as spaces, for copying). */
  before?: string
}

export interface PdfTextRun {
  font: string
  size: number
  color: Rgb
  opacity?: number
  /** Baseline, in points from the top of the sheet. */
  baseline: number
  words: PdfWord[]
}

export interface PdfInfo {
  title: string
  producer: string
  creationDate: Date
  /** Natural language of the text, e.g. "en". */
  lang?: string
}

interface FontEntry {
  key: string
  font: TrueTypeFont
  fakeBold: boolean
  fakeItalic: boolean
  resource: string
  used: Map<number, number>
}

const enc = new TextEncoder()

/** Number formatting for PDF operators (no exponents, at most 3 decimals). */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const r = Math.round(n * 1000) / 1000
  if (Object.is(r, -0) || r === 0) return '0'
  return String(r).includes('e') ? r.toFixed(3) : String(r)
}

const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0')

function utf16Hex(s: string): string {
  let out = 'FEFF'
  for (let i = 0; i < s.length; i++) out += hex4(s.charCodeAt(i))
  return `<${out}>`
}

/** A PDF text string: plain literal for ASCII, UTF-16BE otherwise. */
export function pdfString(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`
  return utf16Hex(s)
}

function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `(D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z)`
}

const rgb = (c: Rgb) => `${fmt(c[0])} ${fmt(c[1])} ${fmt(c[2])}`

/** PNG-style row filters (None/Sub/Up, chosen per row) for Flate predictor 15. */
function pngFilter(data: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels
  const out = new Uint8Array((stride + 1) * height)
  const sub = new Uint8Array(stride)
  const up = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const row = y * stride
    const prev = row - stride
    let costNone = 0
    let costSub = 0
    let costUp = 0
    for (let i = 0; i < stride; i++) {
      const v = data[row + i]
      const s = (v - (i >= channels ? data[row + i - channels] : 0)) & 0xff
      const u = (v - (y > 0 ? data[prev + i] : 0)) & 0xff
      sub[i] = s
      up[i] = u
      costNone += v < 128 ? v : 256 - v
      costSub += s < 128 ? s : 256 - s
      costUp += u < 128 ? u : 256 - u
    }
    const o = y * (stride + 1)
    if (costUp <= costSub && costUp <= costNone) {
      out[o] = 2
      out.set(up, o + 1)
    } else if (costSub <= costNone) {
      out[o] = 1
      out.set(sub, o + 1)
    } else {
      out[o] = 0
      out.set(data.subarray(row, row + stride), o + 1)
    }
  }
  return out
}

export class PdfPage {
  readonly width: number
  readonly height: number
  readonly ops: string[] = []
  readonly fonts = new Set<string>()
  readonly images = new Set<string>()
  readonly states = new Map<string, number>()
  readonly links: { rect: [number, number, number, number]; uri: string }[] = []
  private readonly doc: PdfWriter

  constructor(doc: PdfWriter, width: number, height: number) {
    this.doc = doc
    this.width = width
    this.height = height
  }

  private y(v: number): number {
    return this.height - v
  }

  private alpha(opacity: number | undefined): string {
    if (opacity === undefined || opacity >= 0.999) return ''
    const a = Math.max(0, Math.round(opacity * 100) / 100)
    const name = `GS${Math.round(a * 100)}`
    this.states.set(name, a)
    return `/${name} gs `
  }

  fillRect(x: number, y: number, w: number, h: number, color: Rgb, opacity?: number): void {
    if (w <= 0 || h <= 0) return
    this.ops.push(`q ${this.alpha(opacity)}${rgb(color)} rg ${fmt(x)} ${fmt(this.y(y + h))} ${fmt(w)} ${fmt(h)} re f Q`)
  }

  private roundPath(x: number, y: number, w: number, h: number, r: number): string {
    r = Math.max(0, Math.min(r, w / 2, h / 2))
    if (r < 0.05) return `${fmt(x)} ${fmt(this.y(y + h))} ${fmt(w)} ${fmt(h)} re`
    const k = r * 0.5523
    const X = (v: number) => fmt(v)
    const Y = (v: number) => fmt(this.y(v))
    return [
      `${X(x + r)} ${Y(y)} m`,
      `${X(x + w - r)} ${Y(y)} l`,
      `${X(x + w - r + k)} ${Y(y)} ${X(x + w)} ${Y(y + r - k)} ${X(x + w)} ${Y(y + r)} c`,
      `${X(x + w)} ${Y(y + h - r)} l`,
      `${X(x + w)} ${Y(y + h - r + k)} ${X(x + w - r + k)} ${Y(y + h)} ${X(x + w - r)} ${Y(y + h)} c`,
      `${X(x + r)} ${Y(y + h)} l`,
      `${X(x + r - k)} ${Y(y + h)} ${X(x)} ${Y(y + h - r + k)} ${X(x)} ${Y(y + h - r)} c`,
      `${X(x)} ${Y(y + r)} l`,
      `${X(x)} ${Y(y + r - k)} ${X(x + r - k)} ${Y(y)} ${X(x + r)} ${Y(y)} c h`,
    ].join(' ')
  }

  fillRoundRect(x: number, y: number, w: number, h: number, r: number, color: Rgb, opacity?: number): void {
    if (w <= 0 || h <= 0) return
    this.ops.push(`q ${this.alpha(opacity)}${rgb(color)} rg ${this.roundPath(x, y, w, h, r)} f Q`)
  }

  /** Outline drawn inside the box (like a CSS border). */
  strokeRoundRect(x: number, y: number, w: number, h: number, r: number, lineWidth: number, color: Rgb, opacity?: number): void {
    if (w <= 0 || h <= 0 || lineWidth <= 0) return
    const half = lineWidth / 2
    this.ops.push(`q ${this.alpha(opacity)}${rgb(color)} RG ${fmt(lineWidth)} w ${this.roundPath(x + half, y + half, w - lineWidth, h - lineWidth, Math.max(0, r - half))} S Q`)
  }

  line(x1: number, y1: number, x2: number, y2: number, width: number, color: Rgb, dash: number[] | null = null, opacity?: number): void {
    const d = dash && dash.length ? `[${dash.map(fmt).join(' ')}] 0 d ` : ''
    this.ops.push(`q ${this.alpha(opacity)}${rgb(color)} RG ${fmt(width)} w ${d}${fmt(x1)} ${fmt(this.y(y1))} m ${fmt(x2)} ${fmt(this.y(y2))} l S Q`)
  }

  /** Limit drawing to a horizontal band of the sheet until `endClip`. */
  clipBand(y: number, h: number): void {
    this.ops.push(`q 0 ${fmt(this.y(y + h))} ${fmt(this.width)} ${fmt(h)} re W n`)
  }

  endClip(): void {
    this.ops.push('Q')
  }

  image(name: string, x: number, y: number, w: number, h: number): void {
    if (w <= 0 || h <= 0) return
    this.images.add(name)
    this.ops.push(`q ${fmt(w)} 0 0 ${fmt(h)} ${fmt(x)} ${fmt(this.y(y + h))} cm /${name} Do Q`)
  }

  link(x: number, y: number, w: number, h: number, uri: string): void {
    this.links.push({ rect: [x, this.y(y + h), x + w, this.y(y)], uri })
  }

  /**
   * One line of text in one font. Each word starts at its measured position and
   * the glyphs are scaled horizontally so the words fill their measured widths
   * (the layout came from the browser, the outlines from the embedded font).
   */
  text(run: PdfTextRun): void {
    const words = run.words.filter((w) => w.text.length > 0)
    if (words.length === 0 || run.size <= 0) return
    const f = this.doc.font(run.font)
    this.fonts.add(f.resource)
    const upm = f.font.unitsPerEm
    const natural = (s: string) => {
      let total = 0
      for (const ch of s) total += f.font.advance(f.font.glyphId(ch.codePointAt(0)!))
      return (total * run.size) / upm
    }
    const glyphs = (s: string) => {
      let h = ''
      for (const ch of s) {
        const cp = ch.codePointAt(0)!
        const u = cp === 0x09 || cp === 0xa0 ? 0x20 : cp
        const g = f.font.glyphId(u)
        if (!f.used.has(g)) f.used.set(g, u)
        h += hex4(g)
      }
      return h
    }
    // Each word gets its own horizontal scale, so it fills exactly the width it
    // had on screen and the spaces between words stay as they were.
    const scaleOf = (w: PdfWord) => {
      const nat = natural(w.text)
      return nat > 0 ? Math.min(2, Math.max(0.5, w.w / nat)) : 1
    }
    // Whitespace between words is written as plain spaces (one per character).
    const spaces = (g: string) => g.replace(/./gu, ' ')
    const lead = spaces(words[0].before ?? '')
    const startX = words[0].x - natural(lead) * scaleOf(words[0])
    const shows: string[] = []
    let pen = startX
    words.forEach((w, i) => {
      const hs = scaleOf(w)
      const parts: string[] = []
      const gap = i === 0 ? lead : spaces(w.before ?? ' ') || ' '
      if (gap) {
        parts.push(`<${glyphs(gap)}>`)
        pen += natural(gap) * hs
      }
      const delta = w.x - pen
      if (Math.abs(delta) > 0.01) parts.push(fmt((-delta * 1000) / (run.size * hs)))
      parts.push(`<${glyphs(w.text)}>`)
      shows.push(`${fmt(hs * 100)} Tz [${parts.join(' ')}] TJ`)
      pen = w.x + natural(w.text) * hs
    })
    const skew = f.fakeItalic ? 0.2 : 0
    const bold = f.fakeBold ? `2 Tr ${fmt(run.size * 0.035)} w ${rgb(run.color)} RG ` : ''
    this.ops.push(`q ${this.alpha(run.opacity)}BT /${f.resource} ${fmt(run.size)} Tf ${bold}${rgb(run.color)} rg 1 0 ${fmt(skew)} 1 ${fmt(startX)} ${fmt(this.y(run.baseline))} Tm ${shows.join(' ')} ET Q`)
  }

  /** Simple single-line text set in the embedded font's own widths (footers, placeholders). */
  plainText(font: string, size: number, color: Rgb, x: number, baseline: number, text: string): void {
    const words: PdfWord[] = []
    let pen = x
    for (const [i, part] of text.split(' ').entries()) {
      if (i > 0) pen += this.measure(font, size, ' ')
      if (part) words.push({ text: part, x: pen, w: this.measure(font, size, part), before: i > 0 ? ' ' : undefined })
      pen += this.measure(font, size, part)
    }
    this.text({ font, size, color, baseline, words })
  }

  /** Width of a string in the font at a size (points), for simple header and footer text. */
  measure(font: string, size: number, s: string): number {
    const f = this.doc.font(font)
    let total = 0
    for (const ch of s) total += f.font.advance(f.font.glyphId(ch.codePointAt(0)!))
    return (total * size) / f.font.unitsPerEm
  }
}

export class PdfWriter {
  private readonly info: PdfInfo
  private readonly fontEntries = new Map<string, FontEntry>()
  private readonly imageList: { name: string; dict: string; data: Uint8Array; smask: { dict: string; data: Uint8Array } | null }[] = []
  private readonly pageList: PdfPage[] = []

  constructor(info: PdfInfo) {
    this.info = info
  }

  get pages(): readonly PdfPage[] {
    return this.pageList
  }

  addFont(key: string, font: TrueTypeFont, options: { fakeBold?: boolean; fakeItalic?: boolean } = {}): void {
    this.fontEntries.set(key, { key, font, fakeBold: !!options.fakeBold, fakeItalic: !!options.fakeItalic, resource: `F${this.fontEntries.size + 1}`, used: new Map([[0, 0]]) })
  }

  hasFont(key: string): boolean {
    return this.fontEntries.has(key)
  }

  /** @internal */
  font(key: string): FontEntry {
    const f = this.fontEntries.get(key)
    if (!f) throw new Error(`font ${key} is not registered`)
    return f
  }

  /** True when the font has a glyph for every character (whitespace aside). */
  covers(key: string, s: string): boolean {
    const f = this.font(key).font
    for (const ch of s) {
      const cp = ch.codePointAt(0)!
      if (cp <= 0x20 || cp === 0xa0) continue
      if (f.glyphId(cp) === 0) return false
    }
    return true
  }

  /**
   * Like `addImage`, but large pictures are compressed in a background worker,
   * so the page stays responsive while a note with many screenshots is exported.
   */
  async addImageAsync(data: PdfImageData): Promise<string> {
    if (data.kind === 'jpeg' || data.rgb.length < 256 * 1024) return this.addImage(data)
    const deflate = (bytes: Uint8Array) => new Promise<Uint8Array>((resolve, reject) => zlib(bytes, { level: 6 }, (err, out) => (err ? reject(err) : resolve(out))))
    const [rgbData, alphaData] = await Promise.all([deflate(pngFilter(data.rgb, data.width, data.height, 3)), data.alpha ? deflate(pngFilter(data.alpha, data.width, data.height, 1)) : Promise.resolve(null)])
    const name = `Im${this.imageList.length + 1}`
    const size = `/Width ${data.width} /Height ${data.height}`
    const parms = (colors: number) => `/Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors ${colors} /BitsPerComponent 8 /Columns ${data.width} >>`
    this.imageList.push({
      name,
      dict: `/Type /XObject /Subtype /Image ${size} /ColorSpace /DeviceRGB /BitsPerComponent 8 ${parms(3)}`,
      data: rgbData,
      smask: alphaData ? { dict: `/Type /XObject /Subtype /Image ${size} /ColorSpace /DeviceGray /BitsPerComponent 8 ${parms(1)}`, data: alphaData } : null,
    })
    return name
  }

  /** Add a raster image (compressed now, so the caller can release its pixels). */
  addImage(data: PdfImageData): string {
    const name = `Im${this.imageList.length + 1}`
    const size = `/Width ${data.width} /Height ${data.height}`
    if (data.kind === 'jpeg') {
      this.imageList.push({ name, dict: `/Type /XObject /Subtype /Image ${size} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, data: data.jpeg, smask: null })
      return name
    }
    const flate = (bytes: Uint8Array, channels: number) => zlibSync(pngFilter(bytes, data.width, data.height, channels), { level: 6 })
    const parms = (colors: number) => `/Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors ${colors} /BitsPerComponent 8 /Columns ${data.width} >>`
    this.imageList.push({
      name,
      dict: `/Type /XObject /Subtype /Image ${size} /ColorSpace /DeviceRGB /BitsPerComponent 8 ${parms(3)}`,
      data: flate(data.rgb, 3),
      smask: data.alpha ? { dict: `/Type /XObject /Subtype /Image ${size} /ColorSpace /DeviceGray /BitsPerComponent 8 ${parms(1)}`, data: flate(data.alpha, 1) } : null,
    })
    return name
  }

  addPage(width: number, height: number): PdfPage {
    const page = new PdfPage(this, width, height)
    this.pageList.push(page)
    return page
  }

  finish(): Uint8Array {
    const objects: (Uint8Array | null)[] = [null]
    const alloc = () => objects.push(null) - 1
    const put = (n: number, s: string) => {
      objects[n] = enc.encode(s)
    }
    const putStream = (n: number, dict: string, data: Uint8Array, compress = true) => {
      const body = compress ? zlibSync(data, { level: 6 }) : data
      const head = enc.encode(`<< ${dict}${compress ? ' /Filter /FlateDecode' : ''} /Length ${body.length} >>\nstream\n`.replace('<<  /', '<< /'))
      const tail = enc.encode('\nendstream')
      const all = new Uint8Array(head.length + body.length + tail.length)
      all.set(head)
      all.set(body, head.length)
      all.set(tail, head.length + body.length)
      objects[n] = all
    }

    const catalog = alloc()
    const pagesObj = alloc()
    const infoObj = alloc()

    // Images.
    const imageRefs = new Map<string, number>()
    for (const img of this.imageList) {
      const n = alloc()
      imageRefs.set(img.name, n)
      let smask = ''
      if (img.smask) {
        const m = alloc()
        putStream(m, img.smask.dict, img.smask.data, false)
        smask = ` /SMask ${m} 0 R`
      }
      putStream(n, img.dict + smask, img.data, false)
    }

    // Pages (fonts are written after, once every glyph in use is known).
    const fontRefs = new Map<string, number>()
    for (const f of this.fontEntries.values()) fontRefs.set(f.resource, alloc())
    const pageRefs: number[] = []
    for (const page of this.pageList) {
      const n = alloc()
      const content = alloc()
      pageRefs.push(n)
      putStream(content, '', enc.encode(page.ops.join('\n')))
      const fonts = [...page.fonts].map((r) => `/${r} ${fontRefs.get(r)} 0 R`).join(' ')
      const images = [...page.images].map((r) => `/${r} ${imageRefs.get(r)} 0 R`).join(' ')
      const states = [...page.states].map(([name, a]) => `/${name} << /Type /ExtGState /ca ${fmt(a)} /CA ${fmt(a)} >>`).join(' ')
      const annots = page.links.map((l) => {
        const a = alloc()
        put(a, `<< /Type /Annot /Subtype /Link /Rect [${l.rect.map(fmt).join(' ')}] /Border [0 0 0] /F 4 /A << /S /URI /URI ${pdfString(l.uri)} >> >>`)
        return `${a} 0 R`
      })
      put(
        n,
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${fmt(page.width)} ${fmt(page.height)}] /Resources << /ProcSet [/PDF /Text /ImageC]${fonts ? ` /Font << ${fonts} >>` : ''}${images ? ` /XObject << ${images} >>` : ''}${states ? ` /ExtGState << ${states} >>` : ''} >> /Contents ${content} 0 R${annots.length ? ` /Annots [${annots.join(' ')}]` : ''} >>`,
      )
    }

    let tagNo = 0
    for (const f of this.fontEntries.values()) {
      const type0 = fontRefs.get(f.resource)!
      const cid = alloc()
      const desc = alloc()
      const file = alloc()
      const toUni = alloc()
      const font = f.font
      const scale = 1000 / font.unitsPerEm
      const subsetTag = Array.from({ length: 6 }, (_, i) => String.fromCharCode(65 + ((tagNo * 7 + i * 3 + (i === 5 ? tagNo : 0)) % 26))).join('')
      tagNo++
      const name = `${subsetTag}+${font.postScriptName || 'Font'}`
      const subset = subsetTrueType(font, f.used.keys())
      putStream(file, `/Length1 ${subset.length}`, subset)
      const flags = 32 | (font.isFixedPitch ? 1 : 0) | (font.italic || f.fakeItalic ? 64 : 0)
      put(
        desc,
        `<< /Type /FontDescriptor /FontName /${name} /Flags ${flags} /FontBBox [${font.bbox.map((v) => fmt(v * scale)).join(' ')}] /ItalicAngle ${fmt(f.fakeItalic ? -11 : font.italicAngle)} /Ascent ${fmt(font.ascent * scale)} /Descent ${fmt(font.descent * scale)} /CapHeight ${fmt(font.capHeight * scale)} /StemV ${font.bold || f.fakeBold ? 120 : 80} /FontFile2 ${file} 0 R >>`,
      )
      const gids = [...f.used.keys()].sort((a, b) => a - b)
      const w: string[] = []
      for (let i = 0; i < gids.length; ) {
        let j = i
        while (j + 1 < gids.length && gids[j + 1] === gids[j] + 1) j++
        w.push(`${gids[i]} [${gids.slice(i, j + 1).map((g) => fmt(font.advance(g) * scale)).join(' ')}]`)
        i = j + 1
      }
      put(cid, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /DW ${fmt(font.advance(0) * scale)} /W [${w.join(' ')}] /CIDToGIDMap /Identity >>`)
      const map = gids.filter((g) => g !== 0 && f.used.get(g)! > 0)
      const chunks: string[] = []
      for (let i = 0; i < map.length; i += 100) {
        const part = map.slice(i, i + 100)
        chunks.push(`${part.length} beginbfchar\n${part.map((g) => `<${hex4(g)}> <${[...String.fromCodePoint(f.used.get(g)!)].map((c) => Array.from({ length: c.length }, (_, k) => hex4(c.charCodeAt(k))).join('')).join('')}>`).join('\n')}\nendbfchar`)
      }
      const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chunks.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`
      putStream(toUni, '', enc.encode(cmap))
      put(type0, `<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${toUni} 0 R >>`)
    }

    put(pagesObj, `<< /Type /Pages /Kids [${pageRefs.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`)
    put(catalog, `<< /Type /Catalog /Pages ${pagesObj} 0 R${this.info.lang ? ` /Lang ${pdfString(this.info.lang)}` : ''} /ViewerPreferences << /DisplayDocTitle true >> >>`)
    put(infoObj, `<< /Title ${pdfString(this.info.title)} /Producer ${pdfString(this.info.producer)} /Creator ${pdfString(this.info.producer)} /CreationDate ${pdfDate(this.info.creationDate)} /ModDate ${pdfDate(this.info.creationDate)} >>`)

    // Assemble with byte offsets for the cross-reference table. The second
    // header line is the customary binary marker.
    const chunks: Uint8Array[] = [new Uint8Array([...enc.encode('%PDF-1.7\n%'), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])]
    let offset = chunks[0].length
    const offsets: number[] = [0]
    for (let n = 1; n < objects.length; n++) {
      const body = objects[n]
      if (!body) throw new Error(`PDF object ${n} was not written`)
      offsets[n] = offset
      const head = enc.encode(`${n} 0 obj\n`)
      const tail = enc.encode('\nendobj\n')
      chunks.push(head, body, tail)
      offset += head.length + body.length + tail.length
    }
    const xref = [`xref\n0 ${objects.length}\n0000000000 65535 f \n`, ...offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('')
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
    chunks.push(enc.encode(`${xref}trailer\n<< /Size ${objects.length} /Root ${catalog} 0 R /Info ${infoObj} 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${offset}\n%%EOF\n`))
    const total = chunks.reduce((s, c) => s + c.length, 0)
    const out = new Uint8Array(total)
    let p = 0
    for (const c of chunks) {
      out.set(c, p)
      p += c.length
    }
    return out
  }
}
