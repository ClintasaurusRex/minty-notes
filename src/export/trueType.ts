/**
 * A small TrueType (glyf-outline) reader and subsetter for embedding fonts in
 * exported PDFs. Pure: no DOM. Only what PDF embedding needs is read: metrics,
 * the Unicode → glyph map, advance widths, and the glyph outlines.
 *
 * Subsetting keeps every glyph ID (unused glyphs become empty), so a PDF can
 * refer to glyphs by their original IDs (CIDToGIDMap /Identity) and the
 * widths stay the font's own.
 */

export interface TrueTypeFont {
  readonly postScriptName: string
  readonly unitsPerEm: number
  readonly numGlyphs: number
  /** Typographic ascent and descent (descent is negative), in font units. */
  readonly ascent: number
  readonly descent: number
  readonly capHeight: number
  readonly bbox: [number, number, number, number]
  readonly italicAngle: number
  readonly isFixedPitch: boolean
  readonly bold: boolean
  readonly italic: boolean
  /** Glyph for a Unicode code point; 0 (.notdef) when the font does not have it. */
  glyphId(codePoint: number): number
  /** Advance width in font units. */
  advance(gid: number): number
  /** Glyphs that a glyph is built from (composite glyphs), including itself. */
  glyphClosure(gids: Iterable<number>): Set<number>
  /** The raw table data (for subsetting). */
  readonly tables: ReadonlyMap<string, Uint8Array>
}

class Reader {
  readonly bytes: Uint8Array
  readonly view: DataView
  constructor(bytes: Uint8Array) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  u8 = (o: number) => this.view.getUint8(o)
  u16 = (o: number) => this.view.getUint16(o)
  i16 = (o: number) => this.view.getInt16(o)
  u32 = (o: number) => this.view.getUint32(o)
  i32 = (o: number) => this.view.getInt32(o)
}

function tag(r: Reader, o: number): string {
  return String.fromCharCode(r.u8(o), r.u8(o + 1), r.u8(o + 2), r.u8(o + 3))
}

function readName(name: Uint8Array | undefined, id: number): string {
  if (!name) return ''
  const r = new Reader(name)
  const count = r.u16(2)
  const strings = r.u16(4)
  let fallback = ''
  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 12
    if (rec + 12 > name.length) break
    const platform = r.u16(rec)
    const nameId = r.u16(rec + 6)
    const len = r.u16(rec + 8)
    const off = strings + r.u16(rec + 10)
    if (nameId !== id || off + len > name.length) continue
    if (platform === 3 || platform === 0) {
      let s = ''
      for (let j = 0; j + 1 < len; j += 2) s += String.fromCharCode(r.u16(off + j))
      return s
    }
    if (platform === 1 && !fallback) {
      for (let j = 0; j < len; j++) fallback += String.fromCharCode(r.u8(off + j))
    }
  }
  return fallback
}

type CmapLookup = (cp: number) => number

function readCmap(cmap: Uint8Array): CmapLookup {
  const r = new Reader(cmap)
  const n = r.u16(2)
  const subtables: { platform: number; encoding: number; offset: number; format: number }[] = []
  for (let i = 0; i < n; i++) {
    const rec = 4 + i * 8
    const offset = r.u32(rec + 4)
    if (offset + 2 > cmap.length) continue
    subtables.push({ platform: r.u16(rec), encoding: r.u16(rec + 2), offset, format: r.u16(offset) })
  }
  const pick =
    subtables.find((s) => s.format === 12 && (s.platform === 3 || s.platform === 0)) ??
    subtables.find((s) => s.format === 4 && s.platform === 3 && s.encoding === 1) ??
    subtables.find((s) => s.format === 4 && s.platform === 0) ??
    subtables.find((s) => s.format === 4)
  if (!pick) throw new Error('the font has no Unicode character map')
  const o = pick.offset
  if (pick.format === 12) {
    const groups = r.u32(o + 12)
    return (cp) => {
      let lo = 0
      let hi = groups - 1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const g = o + 16 + mid * 12
        const start = r.u32(g)
        const end = r.u32(g + 4)
        if (cp < start) hi = mid - 1
        else if (cp > end) lo = mid + 1
        else return r.u32(g + 8) + (cp - start)
      }
      return 0
    }
  }
  const segX2 = r.u16(o + 6)
  const seg = segX2 / 2
  const ends = o + 14
  const starts = ends + segX2 + 2
  const deltas = starts + segX2
  const ranges = deltas + segX2
  return (cp) => {
    if (cp > 0xffff) return 0
    let lo = 0
    let hi = seg - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const end = r.u16(ends + mid * 2)
      const start = r.u16(starts + mid * 2)
      if (cp > end) lo = mid + 1
      else if (cp < start) hi = mid - 1
      else {
        const delta = r.i16(deltas + mid * 2)
        const rangeOffset = r.u16(ranges + mid * 2)
        if (rangeOffset === 0) return (cp + delta) & 0xffff
        const at = ranges + mid * 2 + rangeOffset + (cp - start) * 2
        if (at + 2 > cmap.length) return 0
        const g = r.u16(at)
        return g === 0 ? 0 : (g + delta) & 0xffff
      }
    }
    return 0
  }
}

/** Parse a TrueType font. Throws for CFF (OpenType/PostScript) fonts and damaged files. */
export function parseTrueType(bytes: Uint8Array): TrueTypeFont {
  const r = new Reader(bytes)
  const version = r.u32(0)
  if (version !== 0x00010000 && tag(r, 0) !== 'true') throw new Error('not a TrueType font')
  const numTables = r.u16(4)
  const tables = new Map<string, Uint8Array>()
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16
    const t = tag(r, rec)
    const offset = r.u32(rec + 8)
    const length = r.u32(rec + 12)
    if (offset + length > bytes.length) throw new Error(`the font table ${t} is damaged`)
    tables.set(t, bytes.subarray(offset, offset + length))
  }
  for (const t of ['head', 'hhea', 'maxp', 'hmtx', 'loca', 'glyf', 'cmap']) if (!tables.has(t)) throw new Error(`the font has no ${t} table`)
  const head = new Reader(tables.get('head')!)
  const hhea = new Reader(tables.get('hhea')!)
  const maxp = new Reader(tables.get('maxp')!)
  const hmtx = new Reader(tables.get('hmtx')!)
  const loca = new Reader(tables.get('loca')!)
  const glyf = tables.get('glyf')!
  const glyfR = new Reader(glyf)
  const os2 = tables.has('OS/2') ? new Reader(tables.get('OS/2')!) : null
  const post = tables.has('post') ? new Reader(tables.get('post')!) : null

  const unitsPerEm = head.u16(18)
  const longLoca = head.i16(50) === 1
  const numGlyphs = maxp.u16(4)
  const hMetrics = hhea.u16(34)
  const lookup = readCmap(tables.get('cmap')!)
  const macStyle = head.u16(44)
  const weight = os2 ? os2.u16(4) : 400
  const ascent = os2 && os2.bytes.length >= 72 ? os2.i16(68) : hhea.i16(4)
  const descent = os2 && os2.bytes.length >= 72 ? os2.i16(70) : hhea.i16(6)
  const capHeight = os2 && os2.u16(0) >= 2 && os2.bytes.length >= 90 ? os2.i16(88) : Math.round(ascent * 0.7)

  const glyphRange = (gid: number): [number, number] => {
    if (gid < 0 || gid >= numGlyphs) return [0, 0]
    const a = longLoca ? loca.u32(gid * 4) : loca.u16(gid * 2) * 2
    const b = longLoca ? loca.u32(gid * 4 + 4) : loca.u16(gid * 2 + 2) * 2
    return b > a && b <= glyf.length ? [a, b] : [a, a]
  }
  const components = (gid: number): number[] => {
    const [a, b] = glyphRange(gid)
    if (b - a < 10 || glyfR.i16(a) >= 0) return []
    const out: number[] = []
    let p = a + 10
    for (let guard = 0; guard < 64 && p + 4 <= b; guard++) {
      const flags = glyfR.u16(p)
      out.push(glyfR.u16(p + 2))
      p += 4 + (flags & 0x0001 ? 4 : 2)
      if (flags & 0x0008) p += 2
      else if (flags & 0x0040) p += 4
      else if (flags & 0x0080) p += 8
      if (!(flags & 0x0020)) break
    }
    return out
  }
  const cache = new Map<number, number>()

  return {
    postScriptName: (readName(tables.get('name'), 6) || 'Font').replace(/[^A-Za-z0-9-]/g, ''),
    unitsPerEm,
    numGlyphs,
    ascent,
    descent,
    capHeight,
    bbox: [head.i16(36), head.i16(38), head.i16(40), head.i16(42)],
    italicAngle: post ? post.i32(4) / 65536 : 0,
    isFixedPitch: post ? post.u32(12) !== 0 : false,
    bold: (macStyle & 1) !== 0 || weight >= 600,
    italic: (macStyle & 2) !== 0,
    tables,
    glyphId(cp) {
      let g = cache.get(cp)
      if (g === undefined) {
        g = lookup(cp)
        if (g >= numGlyphs) g = 0
        cache.set(cp, g)
      }
      return g
    },
    advance(gid) {
      if (gid < 0 || gid >= numGlyphs) return 0
      const i = Math.min(gid, hMetrics - 1)
      return hmtx.u16(i * 4)
    },
    glyphClosure(gids) {
      const out = new Set<number>([0])
      const stack = [...gids]
      while (stack.length) {
        const g = stack.pop()!
        if (g < 0 || g >= numGlyphs || out.has(g)) continue
        out.add(g)
        stack.push(...components(g))
      }
      // .notdef may itself be composite (rare); keep its parts too.
      for (const c of components(0)) if (!out.has(c)) out.add(c)
      return out
    },
  }
}

const KEEP_TABLES = ['OS/2', 'cmap', 'cvt ', 'fpgm', 'gasp', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'prep']

function checksum(data: Uint8Array): number {
  let sum = 0
  const padded = data.length % 4 === 0 ? data : (() => {
    const p = new Uint8Array(data.length + (4 - (data.length % 4)))
    p.set(data)
    return p
  })()
  const v = new DataView(padded.buffer, padded.byteOffset, padded.byteLength)
  for (let i = 0; i < padded.length; i += 4) sum = (sum + v.getUint32(i)) >>> 0
  return sum
}

/**
 * A copy of the font that keeps only the outlines of `gids` (plus the glyphs
 * composite glyphs are built from, and .notdef). Glyph IDs, metrics, and
 * hinting programs are unchanged, so widths in the PDF match the font.
 */
export function subsetTrueType(font: TrueTypeFont, gids: Iterable<number>): Uint8Array {
  const keep = font.glyphClosure(gids)
  const src = font.tables
  const glyf = src.get('glyf')!
  const loca = new Reader(src.get('loca')!)
  const longLoca = new Reader(src.get('head')!).i16(50) === 1
  const range = (gid: number): [number, number] => {
    const a = longLoca ? loca.u32(gid * 4) : loca.u16(gid * 2) * 2
    const b = longLoca ? loca.u32(gid * 4 + 4) : loca.u16(gid * 2 + 2) * 2
    return b > a && b <= glyf.length ? [a, b] : [a, a]
  }
  let size = 0
  for (const g of keep) {
    const [a, b] = range(g)
    size += (b - a + 3) & ~3
  }
  const newGlyf = new Uint8Array(Math.max(4, size))
  const newLoca = new Uint8Array((font.numGlyphs + 1) * 4)
  const locaView = new DataView(newLoca.buffer)
  let at = 0
  for (let g = 0; g < font.numGlyphs; g++) {
    locaView.setUint32(g * 4, at)
    if (!keep.has(g)) continue
    const [a, b] = range(g)
    newGlyf.set(glyf.subarray(a, b), at)
    at += (b - a + 3) & ~3
  }
  locaView.setUint32(font.numGlyphs * 4, at)

  const out = new Map<string, Uint8Array>()
  for (const t of KEEP_TABLES) {
    const data = src.get(t)
    if (data) out.set(t, data.slice())
  }
  out.set('glyf', newGlyf.subarray(0, Math.max(4, at)))
  out.set('loca', newLoca)
  const head = out.get('head')!
  const headView = new DataView(head.buffer, head.byteOffset, head.byteLength)
  headView.setInt16(50, 1) // long offsets
  headView.setUint32(8, 0) // checkSumAdjustment, set below
  // post format 3: no glyph names (keeps italic angle and pitch).
  const post = new Uint8Array(32)
  const srcPost = src.get('post')
  if (srcPost && srcPost.length >= 32) post.set(srcPost.subarray(0, 32))
  new DataView(post.buffer).setUint32(0, 0x00030000)
  out.set('post', post)

  const tags = [...out.keys()].sort()
  const n = tags.length
  let offset = 12 + n * 16
  const layout = tags.map((t) => {
    const data = out.get(t)!
    const rec = { tag: t, data, offset }
    offset += (data.length + 3) & ~3
    return rec
  })
  const file = new Uint8Array(offset)
  const v = new DataView(file.buffer)
  const pow = 2 ** Math.floor(Math.log2(n))
  v.setUint32(0, 0x00010000)
  v.setUint16(4, n)
  v.setUint16(6, pow * 16)
  v.setUint16(8, Math.log2(pow))
  v.setUint16(10, n * 16 - pow * 16)
  layout.forEach((rec, i) => {
    const p = 12 + i * 16
    for (let j = 0; j < 4; j++) v.setUint8(p + j, rec.tag.charCodeAt(j))
    v.setUint32(p + 4, checksum(rec.data))
    v.setUint32(p + 8, rec.offset)
    v.setUint32(p + 12, rec.data.length)
    file.set(rec.data, rec.offset)
  })
  const headRec = layout.find((l) => l.tag === 'head')!
  v.setUint32(headRec.offset + 8, (0xb1b0afba - checksum(file)) >>> 0)
  return file
}
