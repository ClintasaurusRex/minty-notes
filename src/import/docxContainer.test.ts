import { strToU8, unzipSync } from 'fflate'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTHING_DECOMPRESSED, resetWork, work } from '../test/countingFflate'
import { makeDocx } from '../test/docFixtures'
import { listTestFiles, nodeBuffer, readTestFile } from '../test/testFiles'
import { centralRecord, concatBytes, crcOf, deflatedEntry, localRecord, rawEntriesOf, rawZip, storedEntry, type RawEntry } from '../test/rawZip'
import { readZipDirectory } from '../backup/zipReader'
import { checkDocxContainer, MAX_DOCX_UNPACKED } from './formats'

vi.mock('fflate', async (original) => (await import('../test/countingFflate')).countingFflate(await original()))

/**
 * The DOCX container check (`checkDocxContainer`), used by "Import document",
 * and for imported originals inside project packages: genuine Word files from
 * many writers pass and still convert; malformed containers are refused —
 * by structure before anything is unpacked, or by bounded unpacking.
 */

const MiB = 1024 * 1024
const MAMMOTH = new URL('../../node_modules/mammoth/test/test-data/', import.meta.url)
const OURS = new URL('../test/files/docx/', import.meta.url)
const docxIn = (dir: URL) => listTestFiles(dir, '.docx')
const GENUINE: [string, URL][] = [...docxIn(MAMMOTH).map((f): [string, URL] => [`Microsoft Word (mammoth's test file ${f})`, new URL(f, MAMMOTH)]), ...docxIn(OURS).map((f): [string, URL] => [f, new URL(f, OURS)])]

const parts = () => rawEntriesOf(makeDocx())

/**
 * The app converts in a worker with mammoth's browser build (`convertDocxToHtml`, which passes an
 * ArrayBuffer); in Node, mammoth wants a Buffer. Same converter, same file, same options.
 */
async function convertsWithMammoth(bytes: Uint8Array): Promise<string> {
  const mammoth = (await import('mammoth')).default
  const result = await mammoth.convertToHtml({ buffer: nodeBuffer(bytes) } as never, { externalFileAccess: false } as never)
  return result.value
}

beforeEach(() => resetWork())

/** Refused for `reason`; returns what the ZIP library was asked to do meanwhile. */
async function refused(bytes: Uint8Array, reason: RegExp) {
  resetWork()
  const result = await checkDocxContainer('test.docx', bytes)
  expect(result.ok, 'the file was accepted').toBe(false)
  if (!result.ok) expect(result.reason).toMatch(reason)
  return { ...work }
}

describe('genuine Word documents from many writers pass the check and still convert', () => {
  it('the collection is all there: 17 files written by Word (shipped with mammoth) and 7 by LibreOffice, Info-ZIP, 7-Zip, and Python', () => {
    expect(GENUINE.length).toBe(24)
  })

  it.each(GENUINE)('%s', async (label, url) => {
    const bytes = readTestFile(url)
    const result = await checkDocxContainer(label, bytes)
    expect(result, label).toEqual({ ok: true, macros: false })
    // Every compressed part was unpacked once, within its recorded size, and nothing else was decompressed.
    const directory = readZipDirectory(bytes, 5000, 'standard')
    const parts = directory.ok ? directory.entries.filter((e) => e.method === 8) : []
    expect(work.inflaters).toBe(parts.length)
    expect(work.bytesOut).toBe(parts.reduce((n, e) => n + e.size, 0))
    expect(work.bulkCalls).toBe(0)
    // The same file still converts (mammoth reads the parts on its own).
    expect(typeof (await convertsWithMammoth(bytes))).toBe('string')
  })

  it('a LibreOffice document and its repacked twins convert to the same text', async () => {
    const texts = await Promise.all(docxIn(OURS).map((f) => convertsWithMammoth(readTestFile(new URL(f, OURS)))))
    expect(texts[0]).toMatch(/Pump Station 3/)
    for (const html of texts) expect(html).toBe(texts[0])
  })
})

describe('malformed containers are refused before anything is unpacked', () => {

  it('the audited 138-byte file: word/document.xml listed at byte 1,048,576, far past the end', async () => {
    const doc = { ...storedEntry('word/document.xml', strToU8('<w:d/>')), offset: 1_048_576 }
    const audited = rawZip([doc])
    expect(audited.length).toBe(138)
    expect(await refused(audited, /“test\.docx” is not a readable \.docx file \("word\/document\.xml" points outside the file\)/)).toEqual(NOTHING_DECOMPRESSED)
  })

  it('any part whose header is outside the file, inside the directory, or missing', async () => {
    const all = parts()
    const styles = all.findIndex((e) => e.name === 'word/styles.xml')
    expect(await refused(rawZip(all.map((e, i) => (i === styles ? { ...e, offset: 0x7fff_0000 } : e))), /points outside the file/)).toEqual(NOTHING_DECOMPRESSED)
    expect(await refused(rawZip(all, (offsets) => all.map((e, i) => centralRecord(e, i === styles ? offsets[i] + 3 : offsets[i]))), /points outside the file/)).toEqual(NOTHING_DECOMPRESSED)
  })

  it('a ZIP without word/document.xml, or a part listed twice', async () => {
    expect(await refused(rawZip(parts().filter((e) => e.name !== 'word/document.xml')), /not a Word document \(no word\/document\.xml\)/)).toEqual(NOTHING_DECOMPRESSED)
    const all = parts()
    expect(await refused(rawZip([...all, all.find((e) => e.name === 'word/document.xml')!]), /the part "word\/document\.xml" appears more than once/)).toEqual(NOTHING_DECOMPRESSED)
  })

  it('a header that contradicts the directory: name, method, CRC, or sizes', async () => {
    const changed = (local: RawEntry['local']) => rawZip(parts().map((e) => (e.name === 'word/document.xml' ? { ...e, local } : e)))
    for (const local of [{ name: 'word/documenX.xml' }, { method: 0 }, { crc: 7 }, { size: 7 }, { compressedSize: 7 }]) {
      expect(await refused(changed(local), /the two records of "word\/document\.xml" contradict each other/), JSON.stringify(local)).toEqual(NOTHING_DECOMPRESSED)
    }
  })

  it('malformed ranges: parts that overlap, a part hidden in another, data that runs into the directory', async () => {
    const all = parts()
    const doc = all.findIndex((e) => e.name === 'word/document.xml')
    expect(await refused(rawZip(all, (offsets) => [...all.map((e, i) => centralRecord(e, offsets[i])), centralRecord({ ...all[doc], name: 'word/copy.xml' }, offsets[doc])]), /contradict each other|overlap/)).toEqual(NOTHING_DECOMPRESSED)
    const inner = storedEntry('word/hidden.xml', strToU8('<x/>'))
    const outer = storedEntry('word/media/image3.png', concatBytes(new Uint8Array(20), localRecord(inner), new Uint8Array(20)))
    const nested = [...all, outer]
    expect(await refused(rawZip(nested, (offsets) => [...nested.map((e, i) => centralRecord(e, offsets[i])), centralRecord(inner, offsets[nested.length - 1] + 30 + outer.name.length + 20)]), /overlap/)).toEqual(NOTHING_DECOMPRESSED)
    const longer = all.map((e, i) => (i === doc ? { ...e, compressedSize: e.data.length + 50_000, local: { compressedSize: e.data.length + 50_000 } } : e))
    expect(await refused(rawZip(longer), /runs past the end of the file/)).toEqual(NOTHING_DECOMPRESSED)
  })

  it('an encrypted part, or a part in a compression method that cannot be read', async () => {
    expect(await refused(rawZip(parts().map((e) => (e.name === 'word/styles.xml' ? { ...e, flags: 1 } : e))), /"word\/styles\.xml" is encrypted/)).toEqual(NOTHING_DECOMPRESSED)
    // Checked part by part in directory order: parts before it are unpacked, it is not.
    const seen = await refused(rawZip(parts().map((e) => (e.name === '[Content_Types].xml' ? { ...e, method: 14 } : e))), /compression method Minty Notes cannot read/)
    expect(seen).toEqual(NOTHING_DECOMPRESSED)
  })
})

describe('sizes are proven by bounded unpacking', () => {
  it('a part that claims a few bytes but holds 32 MiB is refused after at most about 1 MiB', async () => {
    const zeros = new Uint8Array(32 * MiB)
    const bomb = { ...deflatedEntry('word/document.xml', zeros), size: 10, crc: crcOf(zeros.subarray(0, 10)) }
    const file = rawZip([bomb, ...parts().filter((e) => e.name !== 'word/document.xml')])
    expect(file.length).toBeLessThan(64 * 1024)
    const seen = await refused(file, /"word\/document\.xml" unpacks to more than the document records for it/)
    expect(seen.inflaters).toBe(1)
    expect(seen.bytesOut).toBeLessThanOrEqual(10 + MiB + 64 * 1024)
  })

  it('parts that honestly declare more than 300 MB in all are refused before anything is unpacked', async () => {
    const big = { ...deflatedEntry('word/media/movie.bin', new Uint8Array(400 * 1024)), size: MAX_DOCX_UNPACKED + 1 }
    expect(await refused(rawZip([...parts(), big]), /would unpack to 300 MB, more than the 300 MB limit/)).toEqual(NOTHING_DECOMPRESSED)
  })

  it('a part whose CRC or size does not match its data is refused', async () => {
    expect((await refused(rawZip(parts().map((e) => (e.name === 'word/document.xml' ? { ...e, crc: e.crc ^ 1 } : e))), /"word\/document\.xml" does not match its ZIP checksum/)).bulkCalls).toBe(0)
    expect((await refused(rawZip(parts().map((e) => (e.name === 'word/document.xml' ? { ...e, size: e.size + 9 } : e))), /unpacks to less than the document records for it/)).bulkCalls).toBe(0)
    // A stored part (pictures are often stored) with a wrong CRC.
    const stored = parts().map((e) => (e.name === 'word/media/image1.png' ? { ...storedEntry(e.name, unzipSync(makeDocx())[e.name]), crc: 1 } : e))
    await refused(rawZip(stored), /"word\/media\/image1\.png" does not match its ZIP checksum/)
  })
})
