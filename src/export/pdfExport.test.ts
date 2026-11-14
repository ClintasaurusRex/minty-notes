import { describe, expect, it } from 'vitest'
import { unzlibSync } from 'fflate'
import sansData from './fonts/LiberationSans-Regular.ttf?inline'
import monoData from './fonts/DejaVuSansMono.ttf?inline'
import { AUTO_LANDSCAPE_BELOW, chooseSheet, pdfFileName, pushDown } from './layoutRules'
import { bandOf, paginate, type PaginationInput } from './paginate'
import { fmt, pdfString, PdfWriter } from './pdfWriter'
import { parseTrueType, subsetTrueType } from './trueType'

const bytesOf = (dataUrl: string) => Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0))
const sans = parseTrueType(bytesOf(sansData))
const mono = parseTrueType(bytesOf(monoData))
const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join('')

/** Streams of a PDF made by the writer, decompressed, with their dictionaries. */
function streams(pdf: Uint8Array): { dict: string; data: Uint8Array }[] {
  const text = latin1(pdf)
  const out: { dict: string; data: Uint8Array }[] = []
  const re = /\d+ 0 obj\s*<<([\s\S]*?)>>\s*stream\n/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const len = parseInt(m[1].match(/\/Length (\d+)/)![1], 10)
    const start = m.index + m[0].length
    const raw = pdf.subarray(start, start + len)
    expect(text.slice(start + len, start + len + 10)).toBe('\nendstream')
    out.push({ dict: m[1], data: m[1].includes('/FlateDecode') && !m[1].includes('/Subtype /Image') ? unzlibSync(raw) : raw })
    re.lastIndex = start + len
  }
  return out
}

/** Every cross-reference entry must point at its object. */
function checkXref(pdf: Uint8Array): number {
  const text = latin1(pdf)
  const at = parseInt(text.slice(text.lastIndexOf('startxref') + 9).trim(), 10)
  expect(text.slice(at, at + 4)).toBe('xref')
  const [, count] = text.slice(at).match(/^xref\s+0\s+(\d+)/)!
  const lines = text.slice(at).split('\n').slice(2, 2 + parseInt(count, 10))
  lines.forEach((line, i) => {
    if (i === 0) return
    expect(text.startsWith(`${i} 0 obj`, parseInt(line.slice(0, 10), 10)), `object ${i}`).toBe(true)
  })
  return parseInt(count, 10)
}

describe('TrueType reading and subsetting', () => {
  it('reads metrics, the character map, and widths', () => {
    expect(sans.postScriptName).toBe('LiberationSans')
    expect(sans.unitsPerEm).toBe(2048)
    expect(sans.glyphId(0x41)).toBeGreaterThan(0)
    expect(sans.advance(sans.glyphId(0x41))).toBe(1366) // Arial-compatible width of "A"
    for (const ch of '°±Ωµ→–—•') expect(sans.glyphId(ch.codePointAt(0)!), ch).toBeGreaterThan(0)
    expect(sans.glyphId(0x1f600)).toBe(0) // emoji are not in the font
    expect(mono.isFixedPitch).toBe(true)
    expect(mono.advance(mono.glyphId(0x69))).toBe(mono.advance(mono.glyphId(0x57)))
    expect(mono.glyphId(0x2500)).toBeGreaterThan(0) // box drawing, for ASCII diagrams in code
  })

  it('keeps only the glyphs in use (and the parts of composite glyphs), with the same IDs and widths', () => {
    const used = [...'Größe 20 °C'].map((c) => sans.glyphId(c.codePointAt(0)!))
    const subset = subsetTrueType(sans, used)
    expect(subset.length).toBeLessThan(sans.tables.get('glyf')!.length / 4)
    const again = parseTrueType(subset)
    expect(again.numGlyphs).toBe(sans.numGlyphs)
    expect(again.unitsPerEm).toBe(sans.unitsPerEm)
    for (const g of used) expect(again.advance(g)).toBe(sans.advance(g))
    expect(again.glyphId(0xf6)).toBe(sans.glyphId(0xf6))
    // Outlines: used glyphs (and their components) are kept byte for byte; others are empty.
    const glyphBytes = (font: typeof sans, gid: number) => {
      const head = font.tables.get('head')!
      const long = new DataView(head.buffer, head.byteOffset).getInt16(50) === 1
      const loca = new DataView(font.tables.get('loca')!.buffer, font.tables.get('loca')!.byteOffset)
      const a = long ? loca.getUint32(gid * 4) : loca.getUint16(gid * 2) * 2
      const b = long ? loca.getUint32(gid * 4 + 4) : loca.getUint16(gid * 2 + 2) * 2
      return font.tables.get('glyf')!.subarray(a, b)
    }
    const closure = sans.glyphClosure(used)
    expect(closure.size).toBeGreaterThanOrEqual(new Set(used).size)
    for (const g of closure) expect(glyphBytes(again, g)).toEqual(glyphBytes(sans, g))
    expect(glyphBytes(again, sans.glyphId(0x5a)).length).toBe(0) // "Z" was not used
    // Table checksums and the whole-file adjustment are consistent.
    const v = new DataView(subset.buffer)
    let sum = 0
    const padded = new Uint8Array(Math.ceil(subset.length / 4) * 4)
    padded.set(subset)
    const pv = new DataView(padded.buffer)
    for (let i = 0; i < padded.length; i += 4) sum = (sum + pv.getUint32(i)) >>> 0
    expect(sum).toBe(0xb1b0afba)
    expect(v.getUint32(0)).toBe(0x00010000)
  })

  it('refuses files that are not TrueType', () => {
    expect(() => parseTrueType(new TextEncoder().encode('OTTO not a font at all, just text'))).toThrow()
  })
})

describe('PDF writer', () => {
  const build = () => {
    const w = new PdfWriter({ title: 'Größe Ω test', producer: 'Minty Notes test', creationDate: new Date('2026-11-07T12:00:00Z'), lang: 'en' })
    w.addFont('sans', sans)
    w.addFont('mono-i', mono, { fakeItalic: true })
    const p = w.addPage(612, 792)
    p.fillRect(36, 36, 100, 20, [0.9, 0.95, 0.93], 0.5)
    p.text({ font: 'sans', size: 12, color: [0, 0, 0], baseline: 50, words: [{ text: 'Hello', x: 40, w: 30 }, { text: 'Größe', x: 75, w: 34, before: ' ' }, { text: '20°C', x: 112, w: 26, before: ' ' }] })
    p.text({ font: 'mono-i', size: 10, color: [0.2, 0.2, 0.2], baseline: 80, words: [{ text: 'IF', x: 60, w: 12, before: '    ' }] })
    const rgb = new Uint8Array(4 * 2 * 3).fill(200)
    const alpha = new Uint8Array(4 * 2).fill(128)
    p.image(w.addImage({ kind: 'raw', width: 4, height: 2, rgb, alpha }), 300, 120, 40, 20)
    p.link(40, 38, 60, 14, 'https://example.com/a(b)')
    p.clipBand(100, 50)
    p.strokeRoundRect(36, 90, 200, 80, 6, 1, [0.5, 0.5, 0.5])
    p.endClip()
    w.addPage(595.28, 841.89).plainText('sans', 8, [0.4, 0.4, 0.4], 36, 800, 'Page 2 of 2')
    return w.finish()
  }

  it('writes a complete file with a valid cross-reference table', () => {
    const pdf = build()
    expect(latin1(pdf.subarray(0, 9))).toBe('%PDF-1.7\n')
    expect(latin1(pdf).trimEnd().endsWith('%%EOF')).toBe(true)
    expect(checkXref(pdf)).toBeGreaterThan(10)
    const text = latin1(pdf)
    expect(text).toContain('/Count 2')
    expect(text).toContain('/MediaBox [0 0 612 792]')
    expect(text).toContain('/MediaBox [0 0 595.28 841.89]')
    expect(text).toContain(`/Title ${pdfString('Größe Ω test')}`)
    expect(text).toContain('/URI (https://example.com/a\\(b\\))')
    expect(text).toMatch(/\/BaseFont \/[A-Z]{6}\+LiberationSans/)
    expect(text).toMatch(/\/BaseFont \/[A-Z]{6}\+DejaVuSansMono/)
    expect(text).toContain('/SMask')
    expect(text).toContain('/CA 0.5')
  })

  it('embeds subset fonts with widths and a Unicode map, and positions each word at its measured place', () => {
    const pdf = build()
    const all = streams(pdf)
    const cmaps = all.filter((s) => latin1(s.data).includes('begincmap')).map((s) => latin1(s.data))
    expect(cmaps.length).toBe(2)
    const g = (ch: string) => sans.glyphId(ch.codePointAt(0)!).toString(16).toUpperCase().padStart(4, '0')
    expect(cmaps.join('\n')).toContain(`<${g('ö')}> <00F6>`)
    expect(cmaps.join('\n')).toContain(`<${g('°')}> <00B0>`)
    const content = all.map((s) => latin1(s.data)).find((t) => t.includes(' Tf '))!
    // Every word has its own horizontal scale: "Hello" fills 30 pt.
    const natural = ([...'Hello'].reduce((s, c) => s + sans.advance(sans.glyphId(c.codePointAt(0)!)), 0) * 12) / 2048
    expect(content).toContain(`${fmt((30 / natural) * 100)} Tz [<${[...'Hello'].map(g).join('')}>] TJ`)
    // The italic monospaced face is slanted from the upright one.
    expect(content).toMatch(/1 0 0\.2 1 \d/)
    // Font programs are real TrueType files that parse again.
    const fontFiles = all.filter((s) => s.dict.includes('/Length1'))
    expect(fontFiles.length).toBe(2)
    for (const f of fontFiles) expect(() => parseTrueType(f.data)).not.toThrow()
  })

  it('writes any whitespace between words as plain spaces (never a missing glyph)', () => {
    const w = new PdfWriter({ title: 't', producer: 'p', creationDate: new Date(0) })
    w.addFont('sans', sans)
    w.addPage(100, 100).text({ font: 'sans', size: 10, color: [0, 0, 0], baseline: 20, words: [{ text: 'a', x: 10, w: 5 }, { text: 'b', x: 30, w: 5, before: '\u2003\t' }] })
    const content = streams(w.finish()).map((s) => latin1(s.data)).find((t) => t.includes(' Tf '))!
    const space = sans.glyphId(0x20).toString(16).toUpperCase().padStart(4, '0')
    expect(content).toContain(`[<${space}${space}>`)
    expect(content).not.toContain('<0000')
  })

  it('formats numbers and strings safely', () => {
    expect(fmt(1 / 3)).toBe('0.333')
    expect(fmt(-0.0001)).toBe('0')
    expect(fmt(1e-7)).toBe('0')
    expect(fmt(123456.7891)).toBe('123456.789')
    expect(pdfString('a(b)\\c')).toBe('(a\\(b\\)\\\\c)')
    expect(pdfString('Ω')).toBe('<FEFF03A9>')
  })
})

describe('page breaks', () => {
  const base = (over: Partial<PaginationInput>): PaginationInput => ({ firstHeight: 1000, height: 1000, items: [], lines: [], solids: [], objects: [], rows: [], blocks: [], ...over })
  const linesFrom = (top: number, count: number, step = 26, glyph = 19) => Array.from({ length: count }, (_, i) => ({ top: top + i * step, bottom: top + i * step + glyph }))

  it('never cuts through a line, and every line lands on exactly one sheet', () => {
    const lines = linesFrom(48, 200)
    const box = { top: 40, bottom: lines[lines.length - 1].bottom + 8 }
    const bands = paginate(base({ items: lines, lines, objects: [box] }))
    expect(bands.length).toBeGreaterThan(4)
    for (const b of bands) {
      expect(b.forced).toBe(false)
      expect(b.end - b.start).toBeLessThanOrEqual(1000 + 0.5)
      for (const l of lines) expect(l.top < b.end - 0.5 && l.bottom > b.end + 0.5).toBe(false)
    }
    const counts = new Array(bands.length).fill(0)
    for (const l of lines) counts[bandOf(bands, l)]++
    expect(counts.reduce((a, c) => a + c, 0)).toBe(200)
    // Sheets are well filled.
    for (const c of counts.slice(0, -1)) expect(c).toBeGreaterThanOrEqual(34)
  })

  it('moves a picture that fits on a sheet to the next sheet instead of cutting it', () => {
    const lines = linesFrom(0, 30)
    const pic = { top: 800, bottom: 1400 }
    const bands = paginate(base({ items: [...lines, pic], lines, solids: [pic], objects: [{ top: 0, bottom: 780 }, pic] }))
    expect(bands[0].end).toBeLessThanOrEqual(800)
    expect(bands[1].start).toBe(800)
    expect(bands[1].end).toBe(1400)
  })

  it('moves a picture that only fits on a full sheet off the shorter first sheet instead of splitting it', () => {
    const pic = { top: 0, bottom: 900 }
    const after = linesFrom(920, 5)
    const bands = paginate(base({ firstHeight: 700, items: [pic, ...after], lines: after, solids: [pic], objects: [pic, { top: 920, bottom: 1050 }] }))
    expect(bands[0]).toEqual({ start: 0, end: 0, forced: false }) // the first sheet keeps only the title
    expect(bands[1].start).toBe(0)
    expect(bands[1].end).toBeGreaterThanOrEqual(900)
    // Below other content, it simply moves to the next sheet.
    const before = linesFrom(0, 5)
    const pic2 = { top: 200, bottom: 1100 }
    const b2 = paginate(base({ firstHeight: 700, items: [...before, pic2], lines: before, solids: [pic2], objects: [{ top: 0, bottom: 130 }, pic2] }))
    expect(b2[0].end).toBeLessThanOrEqual(200)
    expect(b2[1]).toMatchObject({ start: 200, end: 1100 })
  })

  it('splits a picture taller than a sheet', () => {
    const pic = { top: 0, bottom: 2500 }
    const bands = paginate(base({ items: [pic], solids: [pic], objects: [pic] }))
    expect(bands.map((b) => [b.start, b.end])).toEqual([
      [0, 1000],
      [1000, 2000],
      [2000, 2500],
    ])
  })

  it('keeps a heading with the text that follows it', () => {
    const before = linesFrom(0, 36) // ends at 929
    const heading = { top: 950, bottom: 985, heading: true }
    const after = linesFrom(1000, 10)
    const lines = [...before, heading, ...after]
    const bands = paginate(base({ items: lines, lines, objects: [{ top: 0, bottom: 1300 }] }))
    expect(bands[0].end).toBeLessThanOrEqual(950)
    expect(bandOf(bands, heading)).toBe(1)
  })

  it('prefers the space between objects, and avoids cutting a table row', () => {
    const a = linesFrom(0, 30) // object A ends at ~773
    const b = linesFrom(800, 20)
    const objects = [{ top: 0, bottom: 780 }, { top: 790, bottom: 1330 }]
    const bands = paginate(base({ items: [...a, ...b], lines: [...a, ...b], objects }))
    expect(bands[0].end).toBeGreaterThanOrEqual(773)
    expect(bands[0].end).toBeLessThanOrEqual(800)
    // A table row spanning 940–1010 (two lines) is not split when a row edge is nearby.
    const rowLines = [...linesFrom(0, 36), { top: 942, bottom: 961 }, { top: 968, bottom: 987 }, ...linesFrom(1020, 10)]
    const rows = [{ top: 900, bottom: 940 }, { top: 940, bottom: 1010 }, { top: 1010, bottom: 1300 }]
    const t = paginate(base({ items: rowLines, lines: rowLines, rows, objects: [{ top: 0, bottom: 1300 }] }))
    expect(t[0].end).toBe(940)
  })

  it('skips blank space, so a large gap never makes an empty sheet', () => {
    const a = linesFrom(0, 5)
    const b = linesFrom(5000, 5)
    const bands = paginate(base({ items: [...a, ...b], lines: [...a, ...b], objects: [{ top: 0, bottom: 130 }, { top: 5000, bottom: 5130 }] }))
    expect(bands.length).toBe(2)
    expect(bands[1].start).toBe(5000)
  })

  it('reports a forced cut when side-by-side text leaves no clean place', () => {
    // Two columns whose lines never line up, packed with no gaps.
    const left = Array.from({ length: 80 }, (_, i) => ({ top: i * 20, bottom: i * 20 + 20 }))
    const right = Array.from({ length: 80 }, (_, i) => ({ top: 10 + i * 20, bottom: 10 + i * 20 + 20 }))
    const lines = [...left, ...right]
    const bands = paginate(base({ items: lines, lines, objects: [{ top: 0, bottom: 1610 }] }))
    expect(bands.some((b) => b.forced)).toBe(true)
    // Every line still belongs to exactly one sheet.
    for (const l of lines) expect(bandOf(bands, l)).toBeGreaterThanOrEqual(0)
  })

  it('uses the smaller first sheet (title block) and returns nothing for an empty note', () => {
    const lines = linesFrom(0, 60)
    const bands = paginate(base({ firstHeight: 600, items: lines, lines, objects: [{ top: 0, bottom: 1560 }] }))
    expect(bands[0].end - bands[0].start).toBeLessThanOrEqual(600)
    expect(paginate(base({}))).toEqual([])
  })
})

describe('layout rules', () => {
  it('fits the content width without enlarging, and picks landscape for wide notes', () => {
    const narrow = chooseSheet('letter', 'auto', 600)
    expect(narrow).toMatchObject({ orientation: 'portrait', scale: 1, width: 612, height: 792 })
    const wide = chooseSheet('letter', 'auto', 1200)
    expect(wide.orientation).toBe('landscape')
    expect(wide.scale).toBeCloseTo(0.8, 5)
    expect(chooseSheet('letter', 'portrait', 1200).scale).toBeLessThan(AUTO_LANDSCAPE_BELOW)
    expect(chooseSheet('a4', 'landscape', 600)).toMatchObject({ orientation: 'landscape', width: 841.89, height: 595.28, scale: 1 })
    // A draft imported at 860 px stays portrait.
    expect(chooseSheet('a4', 'auto', 860).orientation).toBe('portrait')
  })

  it('moves things below a text box that grew, and nothing else', () => {
    const ys = pushDown([
      { id: 'a', x: 48, y: 48, w: 600, h: 200, newH: 260 },
      { id: 'img', x: 48, y: 264, w: 400, h: 300, newH: 300 },
      { id: 'b', x: 48, y: 580, w: 600, h: 100, newH: 100 },
      { id: 'side', x: 700, y: 264, w: 300, h: 100, newH: 100 },
      { id: 'overlap', x: 100, y: 100, w: 100, h: 50, newH: 50 },
    ])
    expect(ys.get('a')).toBe(48)
    expect(ys.get('img')).toBe(324)
    expect(ys.get('b')).toBe(640)
    expect(ys.get('side')).toBe(264) // not below the grown box
    expect(ys.get('overlap')).toBe(100) // placed over it on purpose: stays
  })

  it('makes safe file names', () => {
    expect(pdfFileName('Pump station 4 — commissioning')).toBe('Pump station 4 — commissioning.pdf')
    expect(pdfFileName('a/b\\c:d*e?"f<g>h|')).toBe('a-b-c-d-e-f-g-h-.pdf')
    expect(pdfFileName('   ')).toBe('Note.pdf')
    expect(pdfFileName('..')).toBe('Note.pdf')
  })
})
