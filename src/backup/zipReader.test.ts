import { deflateSync, strToU8, zipSync } from 'fflate'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTHING_DECOMPRESSED, resetWork, work } from '../test/countingFflate'
import { PNG_1x1 } from '../test/fixtures'
import { centralRecord, concatBytes, crcOf, deflatedEntry, endRecord, extraField, localRecord, rawZip, storedEntry, streamed, zip64Field, type RawEntry } from '../test/rawZip'
import { checkEntry, crc32, entryBytes, readZipDirectory, type ZipEntry } from './zipReader'

vi.mock('fflate', async (original) => (await import('../test/countingFflate')).countingFflate(await original()))

/**
 * The shared ZIP reader (backups, Word documents, project packages): what it
 * accepts in its `standard` layout, what it refuses, and how unpacking is
 * bounded. Hostile archives are made record by record (`src/test/rawZip.ts`).
 */

const MiB = 1024 * 1024
const MAX32 = 0xffffffff
const XML = strToU8('<?xml version="1.0"?><w:document><w:body>' + '<w:p><w:r><w:t>Verify 24 VDC at terminal X2:14</w:t></w:r></w:p>'.repeat(300) + '</w:body></w:document>')
const CONTENT: Record<string, Uint8Array> = { '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'), 'word/': new Uint8Array(0), 'word/document.xml': XML, 'word/media/image1.png': PNG_1x1 }
const base = (): RawEntry[] => [deflatedEntry('[Content_Types].xml', CONTENT['[Content_Types].xml']), storedEntry('word/', CONTENT['word/']), deflatedEntry('word/document.xml', XML), storedEntry('word/media/image1.png', PNG_1x1)]

beforeEach(() => resetWork())

function accepted(zip: Uint8Array): ZipEntry[] {
  const directory = readZipDirectory(zip, 100, 'standard')
  if (!directory.ok) throw new Error(`refused: ${directory.reason} (${directory.detail})`)
  return directory.entries
}

function refusedAs(zip: Uint8Array, reason: string, detail: RegExp) {
  const directory = readZipDirectory(zip, 100, 'standard')
  expect(directory.ok, 'the archive was accepted').toBe(false)
  if (!directory.ok) {
    expect(directory.reason).toBe(reason)
    expect(directory.detail).toMatch(detail)
  }
  // The directory step never decompresses, whatever it finds.
  expect(work).toEqual(NOTHING_DECOMPRESSED)
}

describe('the standard layout reads what real ZIP writers produce', () => {
  const variants: [string, () => Uint8Array][] = [
    ['fflate, the writer Minty Notes uses', () => zipSync({ '[Content_Types].xml': CONTENT['[Content_Types].xml'], 'word/': [CONTENT['word/'], { level: 0 }], 'word/document.xml': XML, 'word/media/image1.png': [PNG_1x1, { level: 0 }] })],
    ['Microsoft Word: deflate option flags, 0xA220 padding in the headers only', () => rawZip(base().map((e) => ({ ...e, flags: e.method === 8 ? 0x0006 : 0, localExtra: extraField(0xa220, new Uint8Array(26)) })))],
    ['LibreOffice, Java, .NET, Go: data descriptors with their signature', () => rawZip(base().map((e) => streamed({ ...e, flags: 0x0800 })))],
    ['data descriptors without a signature', () => rawZip(base().map((e) => streamed(e, false)))],
    ['Info-ZIP: different extra fields in the header and in the directory', () => rawZip(base().map((e) => ({ ...e, localExtra: concatBytes(extraField(0x5455, new Uint8Array(9)), extraField(0x7875, new Uint8Array(11))), centralExtra: concatBytes(extraField(0x5455, new Uint8Array(5)), extraField(0x7875, new Uint8Array(1))) })))],
    ['7-Zip: NTFS times in the directory', () => rawZip(base().map((e) => ({ ...e, centralExtra: extraField(0x000a, new Uint8Array(32)) })))],
    ['an archive comment and file comments', () => rawZip(base().map((e) => ({ ...e, comment: strToU8('part') })), null, { comment: strToU8('zipped again by hand') })],
    ['padding between entries (aligning tools)', () => rawZip(base().map((e, i) => (i === 2 ? { ...e, padding: new Uint8Array(13) } : e)))],
    ['ZIP64 sizes in the headers only (Python with force_zip64)', () => rawZip(base().map((e) => ({ ...e, local: { compressedSize: MAX32, size: MAX32 }, localExtra: zip64Field(e.size, e.data.length) })))],
    [
      'full ZIP64 records (Info-ZIP zip -fz)',
      () => {
        const entries = base().map((e) => ({ ...e, local: { compressedSize: MAX32, size: MAX32 }, localExtra: zip64Field(e.size, e.data.length) }))
        return rawZip(entries, (offsets) => entries.map((e, i) => centralRecord({ ...e, size: MAX32, compressedSize: MAX32, offset: MAX32, centralExtra: zip64Field(e.size, e.data.length, offsets[i]) }, offsets[i])), { zip64: true })
      },
    ],
  ]

  it.each(variants)('%s', async (_label, make) => {
    const zip = make()
    const entries = accepted(zip)
    expect(entries.map((e) => e.name)).toEqual(Object.keys(CONTENT))
    for (const e of entries) {
      expect([...(await entryBytes(zip, e, 10 * MiB, 'document'))]).toEqual([...CONTENT[e.name]])
      await expect(checkEntry(zip, e, 10 * MiB, 'document')).resolves.toBeUndefined()
    }
    expect(work.bulkCalls).toBe(0)
  })

  it('the minty layout (project packages) still accepts only what the app itself writes', () => {
    const [fflate, ...others] = variants.map(([, make]) => make())
    expect(readZipDirectory(fflate, 100, 'minty').ok).toBe(true)
    for (const zip of others) expect(readZipDirectory(zip, 100, 'minty')).toMatchObject({ ok: false, reason: expect.stringMatching(/foreign|incomplete/) })
  })
})

describe('the standard layout refuses broken or hostile structure, before anything is unpacked', () => {
  const good = () => rawZip(base())
  const end = (zip: Uint8Array) => new DataView(zip.buffer, zip.byteOffset, zip.byteLength)

  it('a header offset beyond the end of the file (the audited 138-byte DOCX), inside the directory, or at no header', () => {
    // The audited file: a tiny ZIP whose directory says word/document.xml starts at byte 1,048,576.
    const tiny = { ...storedEntry('word/document.xml', strToU8('<w:document/>')), offset: 1_048_576 }
    const audited = rawZip([tiny])
    expect(audited.length).toBeLessThan(200)
    refusedAs(audited, 'incomplete', /"word\/document\.xml" points outside the file/)
    const entries = base()
    refusedAs(rawZip(entries, (offsets) => entries.map((e, i) => centralRecord(e, i === 2 ? offsets.at(-1)! + localRecord(entries.at(-1)!).length : offsets[i]))), 'incomplete', /points outside the file/)
    refusedAs(rawZip(entries, (offsets) => entries.map((e, i) => centralRecord(e, i === 2 ? offsets[2] + 7 : offsets[i]))), 'incomplete', /points outside the file/)
  })

  it('a header that contradicts the directory: another name, method, CRC, or size', () => {
    const changed = (local: RawEntry['local']) => rawZip(base().map((e) => (e.name === 'word/document.xml' ? { ...e, local } : e)))
    refusedAs(changed({ name: 'word/documenX.xml' }), 'foreign', /the two records of "word\/document\.xml" contradict each other/)
    refusedAs(changed({ method: 0 }), 'foreign', /contradict each other/)
    refusedAs(changed({ crc: 12345 }), 'foreign', /contradict each other/)
    refusedAs(changed({ size: 7 }), 'foreign', /contradict each other/)
    refusedAs(changed({ compressedSize: 7 }), 'foreign', /contradict each other/)
    // With a data descriptor the header may hold zeros — but not other values.
    refusedAs(rawZip(base().map((e) => (e.name === 'word/document.xml' ? { ...streamed(e), local: { crc: 0, compressedSize: 0, size: 7 } } : e))), 'foreign', /contradict each other/)
    // A stored entry whose two recorded sizes differ.
    refusedAs(rawZip(base().map((e) => (e.name === 'word/media/image1.png' ? { ...e, size: e.size + 1, local: { size: e.size + 1 } } : e))), 'foreign', /the sizes recorded for "word\/media\/image1\.png" contradict each other/)
  })

  it('data that runs into the directory, entries that overlap, one entry hidden inside another', () => {
    const entries = base()
    const longer = entries.map((e) => (e.name === 'word/document.xml' ? { ...e, compressedSize: e.data.length + 5000, local: { compressedSize: e.data.length + 5000 } } : e))
    refusedAs(rawZip(longer), 'incomplete', /the data of "word\/document\.xml" runs past the end of the file/)
    // The directory lists the same bytes twice (one small piece of data as many files).
    refusedAs(rawZip(entries, (offsets) => [...entries.map((e, i) => centralRecord(e, offsets[i])), centralRecord(entries[2], offsets[2])]), 'foreign', /two of its files overlap/)
    // A whole entry (header and data) laid inside another entry's data.
    const inner = storedEntry('word/hidden.xml', strToU8('<x/>'))
    const outer = storedEntry('word/media/image1.png', concatBytes(new Uint8Array(40), localRecord(inner), new Uint8Array(40)))
    const nested = [...entries.slice(0, 3), outer]
    refusedAs(rawZip(nested, (offsets) => [...nested.map((e, i) => centralRecord(e, offsets[i])), centralRecord(inner, offsets[3] + 30 + outer.name.length + 40)]), 'foreign', /two of its files overlap/)
  })

  it('an end record that does not match the directory, a cut-off file, bytes after the end, two end records', () => {
    const zip = good()
    const at = zip.length - 22
    const withEnd = (field: number, value: number, wide = false) => {
      const copy = zip.slice()
      if (wide) end(copy).setUint32(at + field, value, true)
      else end(copy).setUint16(at + field, value, true)
      return copy
    }
    // More records claimed than the directory holds (both counts agree with each other).
    const five = withEnd(10, 5)
    end(five).setUint16(at + 8, 5, true)
    refusedAs(five, 'incomplete', /list of files is damaged or cut off/)
    refusedAs(withEnd(8, 3), 'foreign', /split over several volumes/)
    refusedAs(withEnd(4, 1), 'foreign', /split over several volumes/)
    refusedAs(withEnd(12, end(zip).getUint32(at + 12, true) - 1, true), 'incomplete', /damaged or cut off/)
    refusedAs(withEnd(16, zip.length + 10, true), 'incomplete', /damaged or cut off/)
    // Fewer records than listed: the end record says 3, the directory holds 4.
    const three = withEnd(10, 3)
    end(three).setUint16(at + 8, 3, true)
    refusedAs(three, 'incomplete', /damaged or cut off/)
    for (const cut of [zip.length - 1, zip.length - 22, Math.floor(zip.length / 2), 30]) refusedAs(zip.subarray(0, cut), 'incomplete', /end of its list of files is missing/)
    refusedAs(concatBytes(zip, strToU8('trailing bytes')), 'incomplete', /end of its list of files is missing/)
    // A comment that holds a second, fitting end record: two readers could see two archives.
    const entries = base()
    const offsets = entries.reduce<number[]>((list, _e, i) => [...list, i === 0 ? 0 : list[i - 1] + localRecord(entries[i - 1]).length], [])
    const directory = concatBytes(...entries.map((e, i) => centralRecord(e, offsets[i])))
    const start = offsets.at(-1)! + localRecord(entries.at(-1)!).length
    const fake = endRecord(entries.length, directory.length, start)
    const twice = concatBytes(...entries.map(localRecord), directory, endRecord(entries.length, directory.length, start, fake))
    refusedAs(twice, 'foreign', /more than one end record/)
  })

  it('encrypted entries, names that claim UTF-8 but are not, broken ZIP64 records', () => {
    refusedAs(rawZip(base().map((e) => (e.name === 'word/document.xml' ? { ...e, flags: 0x0001 } : e))), 'foreign', /"word\/document\.xml" is encrypted/)
    const badName = { ...storedEntry('ab', strToU8('x')), flags: 0x0800 }
    const bad = rawZip([badName])
    for (const [i, b] of [0xc3, 0x28].entries()) {
      bad[30 + i] = b
      bad[bad.length - 22 - 46 - 2 + 46 + i] = b
    }
    refusedAs(bad, 'foreign', /claims to be UTF-8/)
    // ZIP64: a locator that points at no record, a record that contradicts the end record, a ZIP64 field that is too short.
    const entries = base().map((e) => ({ ...e }))
    const full = (patch: (zip: Uint8Array, view: DataView) => void, centralExtra?: (e: RawEntry, offset: number) => Uint8Array) => {
      const zip = rawZip(entries, (offsets) => entries.map((e, i) => (centralExtra ? centralRecord({ ...e, size: MAX32, compressedSize: MAX32, centralExtra: centralExtra(e, offsets[i]) }, offsets[i]) : centralRecord(e, offsets[i]))), { zip64: true })
      patch(zip, end(zip))
      return zip
    }
    refusedAs(full((zip, v) => v.setUint32(zip.length - 22 - 20 + 8, 3, true)), 'incomplete', /ZIP64 end record is missing/)
    refusedAs(full((zip, v) => v.setUint16(zip.length - 22 + 10, 3, true)), 'foreign', /two end records contradict each other/)
    refusedAs(
      full(() => undefined, (e) => zip64Field(e.size)),
      'incomplete',
      /ZIP64 sizes of .* are damaged/,
    )
  })

  it('too many entries: judged from the end record alone, before any record is read', () => {
    const one = storedEntry('a.txt', strToU8('a'))
    const claims = concatBytes(localRecord(one), centralRecord(one, 0), endRecord(60_000, 46 + 5, localRecord(one).length))
    expect(readZipDirectory(claims, 5000, 'standard')).toEqual({ ok: false, reason: 'too-many', detail: 'it lists 60,000 files', count: 60_000 })
    // An end record that claims more records than its directory can hold.
    const view = new DataView(claims.buffer)
    view.setUint16(claims.length - 22 + 8, 4000, true)
    view.setUint16(claims.length - 22 + 10, 4000, true)
    expect(readZipDirectory(claims, 5000, 'standard')).toMatchObject({ ok: false, reason: 'incomplete', detail: expect.stringMatching(/damaged or cut off/) })
  })
})

describe('unpacking is bounded by the bytes really produced', () => {
  const only = (e: RawEntry) => {
    const zip = rawZip([e])
    return { zip, entry: accepted(zip)[0] }
  }

  it('an entry that claims 16 bytes but holds 64 MiB is refused after at most about 1 MiB', async () => {
    const zeros = new Uint8Array(64 * MiB)
    const real = deflatedEntry('records.json', zeros)
    const { zip, entry } = only({ ...real, size: 16, crc: crcOf(zeros.subarray(0, 16)) })
    expect(zip.length).toBeLessThan(80 * 1024)
    resetWork()
    const started = performance.now()
    await expect(entryBytes(zip, entry, 512 * MiB, 'backup')).rejects.toThrow(/"records\.json" unpacks to more than the backup records for it/)
    expect(work.inflaters).toBe(1)
    expect(work.bytesOut).toBeLessThanOrEqual(16 + MiB + 64 * 1024)
    expect(work.compressedBytesIn).toBeLessThanOrEqual(2048)
    expect(performance.now() - started).toBeLessThan(1000)
    resetWork()
    await expect(checkEntry(zip, entry, 512 * MiB, 'document')).rejects.toThrow(/unpacks to more than the document records for it/)
    expect(work.bytesOut).toBeLessThanOrEqual(16 + MiB + 64 * 1024)
  })

  it('an entry that claims more than it holds is refused once its data runs out', async () => {
    const content = strToU8('{"records": []}'.repeat(1000))
    const real = deflatedEntry('records.json', content)
    const { zip, entry } = only({ ...real, size: content.length + 100 })
    await expect(entryBytes(zip, entry, MiB, 'backup')).rejects.toThrow(/unpacks to less than the backup records for it/)
    expect(work.bytesOut).toBe(content.length)
  })

  it('claims deflate cannot produce, entries over their limit, and unknown methods are refused without inflating', async () => {
    const real = deflatedEntry('records.json', new Uint8Array(4096))
    const lie = only({ ...real, size: real.data.length * 1032 + 513 })
    await expect(entryBytes(lie.zip, lie.entry, 512 * MiB, 'backup')).rejects.toThrow(/the sizes recorded for "records\.json" contradict each other/)
    const ok = only(real)
    await expect(entryBytes(ok.zip, ok.entry, 4095, 'backup')).rejects.toThrow(/larger than Minty Notes accepts/)
    const bzip2 = only({ ...real, method: 12 })
    await expect(checkEntry(bzip2.zip, bzip2.entry, MiB, 'document')).rejects.toThrow(/compression method Minty Notes cannot read/)
    expect(work).toEqual(NOTHING_DECOMPRESSED)
  })

  it('a wrong CRC is refused; stored entries are checked by checkEntry and returned in place by entryBytes', async () => {
    const content = strToU8('Verify 24 VDC'.repeat(50))
    const deflated = only({ ...deflatedEntry('a.xml', content), crc: 1 })
    await expect(entryBytes(deflated.zip, deflated.entry, MiB, 'document')).rejects.toThrow(/"a\.xml" does not match its ZIP checksum/)
    await expect(checkEntry(deflated.zip, deflated.entry, MiB, 'document')).rejects.toThrow(/does not match its ZIP checksum/)
    const stored = only({ ...storedEntry('b.png', PNG_1x1), crc: 1 })
    await expect(checkEntry(stored.zip, stored.entry, MiB, 'document')).rejects.toThrow(/"b\.png" does not match its ZIP checksum/)
    // Callers of entryBytes check stored files with their SHA-256 instead (backups, packages): a view, no copy.
    const view = await entryBytes(stored.zip, stored.entry, MiB, 'backup')
    expect(view.buffer).toBe(stored.zip.buffer)
  })

  it('large real entries come out exactly, however compressible (the buffer grows with real output)', async () => {
    const random = new Uint8Array(3 * MiB).map((_, i) => (i * 2654435761) >>> 24)
    for (const content of [new Uint8Array(5 * MiB), random, strToU8('{"id":"page-1","title":"Panel notes"},'.repeat(80_000))]) {
      const { zip, entry } = only(deflatedEntry('records.json', content))
      resetWork()
      const out = await entryBytes(zip, entry, 512 * MiB, 'backup')
      expect([out.byteLength, crc32(out)]).toEqual([content.byteLength, crcOf(content)])
      expect(work.bytesOut).toBe(content.byteLength)
      await expect(checkEntry(zip, entry, 512 * MiB, 'document')).resolves.toBeUndefined()
    }
  })

  it('an empty deflated entry and an empty stored folder unpack to nothing', async () => {
    for (const e of [deflatedEntry('empty.txt', new Uint8Array(0)), storedEntry('word/', new Uint8Array(0))]) {
      const { zip, entry } = only(e)
      expect((await entryBytes(zip, entry, 10, 'document')).byteLength).toBe(0)
      await expect(checkEntry(zip, entry, 10, 'document')).resolves.toBeUndefined()
    }
    expect(deflateSync(new Uint8Array(0)).length).toBeGreaterThan(0)
  })
})
