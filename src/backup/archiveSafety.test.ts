import { strToU8 } from 'fflate'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceRecords } from '../domain/types'
import { NOTHING_DECOMPRESSED, resetWork, work } from '../test/countingFflate'
import { sourceWorkspace } from '../test/portableFixtures'
import { centralRecord, concatBytes, crcOf, deflatedEntry, endRecord, extraField, localRecord, rawEntriesOf, rawZip, storedEntry, streamed, zip64Field, type RawEntry } from '../test/rawZip'
import { buildArchive, readArchive, sha256Hex } from './archive'

vi.mock('fflate', async (original) => (await import('../test/countingFflate')).countingFflate(await original()))

/**
 * ZIP safety of backup restore (Settings → Restore). A backup file is hostile
 * until proven otherwise: every way the ZIP library can decompress is counted,
 * so a test can state that a file was refused WITHOUT anything being
 * decompressed — not merely that it was refused in the end.
 */

const MiB = 1024 * 1024
const GiB = 1024 * MiB
let records: WorkspaceRecords
let blobs: Map<string, Blob>
let good: Uint8Array
let entries: RawEntry[]
const entry = (name: string) => entries.find((e) => e.name === name)!
const others = (...names: string[]) => entries.filter((e) => !names.includes(e.name))
const attachments = () => entries.filter((e) => e.name.startsWith('attachments/'))
const json = (value: unknown) => strToU8(JSON.stringify(value))
const manifestOf = () => JSON.parse(new TextDecoder().decode(rawUnpacked('manifest.json'))) as { records: { size: number; sha256: string }; files: { attachmentId: string; path: string; size: number; sha256: string }[] }
let rawUnpacked: (name: string) => Uint8Array

beforeAll(async () => {
  const src = await sourceWorkspace()
  ;({ records, blobs } = await src.store.repository.readAll())
  good = await buildArchive(records, blobs, 'test')
  entries = rawEntriesOf(good)
  const { inflateSync } = await vi.importActual<typeof import('fflate')>('fflate')
  rawUnpacked = (name) => (entry(name).method === 8 ? inflateSync(entry(name).data) : entry(name).data)
})

beforeEach(() => resetWork())

/** Refused with `reason`; returns what the ZIP library was asked to do meanwhile. */
async function refused(bytes: Uint8Array, reason: RegExp) {
  resetWork()
  const result = await readArchive(bytes)
  expect(result.ok, result.ok ? 'the backup was accepted' : result.errors.join(' | ')).toBe(false)
  expect((result.ok ? [] : result.errors).join(' | ')).toMatch(reason)
  return { ...work }
}

describe('the audited reproductions', () => {
  it('entries that declare 16 bytes in all but unpack to 16 MiB are refused after at most about 1 MiB of output', async () => {
    const zeros = new Uint8Array(8 * MiB)
    const forged = (name: string) => ({ ...deflatedEntry(name, zeros), size: 8, crc: crcOf(zeros.subarray(0, 8)) })
    const archive = rawZip([forged('manifest.json'), forged('records.json')])
    expect(archive.length).toBeLessThan(32 * 1024)
    const seen = await refused(archive, /The backup is damaged: "manifest\.json" unpacks to more than the backup records for it/)
    // One bounded attempt on the manifest; records.json is never touched.
    expect(seen.inflaters).toBe(1)
    expect(seen.bytesOut).toBeLessThanOrEqual(8 + MiB + 64 * 1024)
    expect(seen.bulkCalls).toBe(0)
  })

  it('eight duplicate compressed manifests (about 3 KB) are refused before anything is unpacked', async () => {
    const manifest = deflatedEntry('manifest.json', new Uint8Array(256 * 1024))
    const archive = rawZip(Array.from({ length: 8 }, () => manifest))
    expect(archive.length).toBeLessThan(4096)
    expect(await refused(archive, /contains the file "manifest\.json" more than once/)).toEqual(NOTHING_DECOMPRESSED)
  })

  it('a duplicate of any entry — before or after the real one — is refused before anything is unpacked', async () => {
    for (const name of ['manifest.json', 'records.json', attachments()[0].name, 'README.txt']) {
      expect(await refused(rawZip([...entries, entry(name)]), /more than once/), name).toEqual(NOTHING_DECOMPRESSED)
      expect(await refused(rawZip([entry(name), ...entries]), /more than once/), name).toEqual(NOTHING_DECOMPRESSED)
    }
  })
})

describe('the structure is checked before anything is unpacked', () => {
  it('unsafe paths refuse the backup', async () => {
    for (const name of ['../evil.txt', '/etc/passwd', 'attachments\\x.png', 'C:/x.png', 'attachments/../../x.png', 'a\u0000b']) {
      expect(await refused(rawZip([...entries, storedEntry(name, strToU8('x'))]), /unsafe file path/), JSON.stringify(name)).toEqual(NOTHING_DECOMPRESSED)
    }
  })

  it('a header that contradicts the directory, points outside the file, or runs into the directory', async () => {
    const changed = (local: RawEntry['local']) => rawZip(entries.map((e) => (e.name === 'records.json' ? { ...e, local } : e)))
    for (const local of [{ name: 'records.jsoX' }, { method: 0 }, { crc: 1 }, { size: 1 }, { compressedSize: 1 }]) {
      expect(await refused(changed(local), /ZIP structure is not valid \(the two records of "records\.json" contradict each other\)/), JSON.stringify(local)).toEqual(NOTHING_DECOMPRESSED)
    }
    const outside = rawZip(entries.map((e) => (e.name === 'manifest.json' ? { ...e, offset: good.length + 4096 } : e)))
    expect(await refused(outside, /damaged or incomplete \("manifest\.json" points outside the file\)/)).toEqual(NOTHING_DECOMPRESSED)
    const longer = rawZip(entries.map((e) => (e.name === 'records.json' ? { ...e, compressedSize: e.data.length + 100_000, local: { compressedSize: e.data.length + 100_000 } } : e)))
    expect(await refused(longer, /damaged or incomplete/)).toEqual(NOTHING_DECOMPRESSED)
  })

  it('overlapping entries: one piece of data listed under two names, or an entry hidden inside another', async () => {
    const records = entry('records.json')
    const twice = rawZip(entries, (offsets) => [...entries.map((e, i) => centralRecord(e, offsets[i])), centralRecord({ ...records }, offsets[entries.indexOf(records)])])
    expect(await refused(twice, /more than once|overlap/)).toEqual(NOTHING_DECOMPRESSED)
    const inner = deflatedEntry('attachments/hidden.png', new Uint8Array(1000))
    const outer = storedEntry('attachments/outer.bin', concatBytes(new Uint8Array(64), localRecord(inner), new Uint8Array(64)))
    const nested = [...entries, outer]
    const at = (offsets: number[]) => offsets[nested.length - 1] + 30 + outer.name.length + 64
    expect(await refused(rawZip(nested, (offsets) => [...nested.map((e, i) => centralRecord(e, offsets[i])), centralRecord(inner, at(offsets))]), /two of its files overlap/)).toEqual(NOTHING_DECOMPRESSED)
  })

  it('a cut-off file, bytes after the end, an end record that disagrees, and more files than allowed', async () => {
    for (const cut of [good.length - 1, good.length - 30, Math.floor(good.length / 2)]) expect(await refused(good.subarray(0, cut), /damaged or incomplete/)).toEqual(NOTHING_DECOMPRESSED)
    expect(await refused(concatBytes(good, strToU8('appended')), /damaged or incomplete/)).toEqual(NOTHING_DECOMPRESSED)
    const one = storedEntry('README.txt', strToU8('x'))
    const many = concatBytes(localRecord(one), centralRecord(one, 0), endRecord(0xffff, 46 + 10, localRecord(one).length))
    expect(await refused(many, /damaged or incomplete/)).toEqual(NOTHING_DECOMPRESSED)
    // More than 200,000 entries claimed (possible only with ZIP64 records): refused from the count alone.
    const claim = rawZip([one], null, { zip64: true })
    const record = claim.length - 22 - 20 - 56
    new DataView(claim.buffer).setBigUint64(record + 24, 200_001n, true)
    new DataView(claim.buffer).setBigUint64(record + 32, 200_001n, true)
    expect(await refused(claim, /lists more than 200,000 files/)).toEqual(NOTHING_DECOMPRESSED)
    // 70,001 entries without ZIP64 records: the 16-bit count wraps around (as fflate's own writer does past
    // 65,535 entries), so the directory holds more records than the end record says — refused, not misread.
    const tiny = storedEntry('attachments/0.png', new Uint8Array(0))
    const crowd = rawZip(Array.from({ length: 70_001 }, (_, i) => ({ ...tiny, name: `x/${i}` })))
    expect(await refused(crowd, /damaged or incomplete/)).toEqual(NOTHING_DECOMPRESSED)
  })
})

describe('recorded sizes are limits, never promises', () => {
  it('a total over 4 GiB, a manifest over 64 MB, or records over 512 MB are refused before they are unpacked', async () => {
    const huge = (name: string, size: number) => ({ ...deflatedEntry(name, new Uint8Array(16)), size })
    expect(await refused(rawZip([...entries, huge('attachments/a.png', 3 * GiB), huge('attachments/b.png', 3 * GiB)]), /larger than Minty Notes can safely restore/)).toEqual(NOTHING_DECOMPRESSED)
    expect(await refused(rawZip([huge('manifest.json', 64 * MiB + 1), ...others('manifest.json')]), /manifest\.json would unpack to 64 MB, more than any backup/)).toEqual(NOTHING_DECOMPRESSED)
    // records.json over its limit (with a manifest that agrees): only the one bounded manifest was read.
    const manifest = manifestOf()
    const bigManifest = deflatedEntry('manifest.json', json({ ...manifest, records: { ...manifest.records, size: 512 * MiB + 1 } }))
    const seen = await refused(rawZip([bigManifest, huge('records.json', 512 * MiB + 1), ...others('manifest.json', 'records.json')]), /records\.json would unpack to 512 MB, more than Minty Notes can restore \(512 MB\)/)
    expect(seen.inflaters).toBe(1)
    expect(seen.bytesOut).toBe(bigManifest.size)
  })

  it('a records.json whose size disagrees with the manifest is refused before it is unpacked', async () => {
    const real = entry('records.json')
    const seen = await refused(rawZip(entries.map((e) => (e === real ? { ...e, size: e.size - 1 } : e))), /records\.json does not match its checksum/)
    expect(seen.inflaters).toBe(1) // the manifest only
  })

  it('a records.json that unpacks to more than recorded is refused after at most about 1 MiB more', async () => {
    const zeros = new Uint8Array(32 * MiB)
    const manifest = manifestOf()
    const fakeRecords = { ...deflatedEntry('records.json', zeros), size: 100, crc: 0 }
    const lyingManifest = deflatedEntry('manifest.json', json({ ...manifest, records: { ...manifest.records, size: 100 } }))
    const seen = await refused(rawZip([lyingManifest, fakeRecords, ...others('manifest.json', 'records.json')]), /"records\.json" unpacks to more than the backup records for it/)
    expect(seen.inflaters).toBe(2)
    expect(seen.bytesOut - lyingManifest.size).toBeLessThanOrEqual(100 + MiB + 64 * 1024)
  })

  it('compressed attachments are each unpacked once, within their recorded size; the first damaged one stops the check', async () => {
    const files = attachments()
    expect(files.length).toBeGreaterThan(1)
    // Zipped again with every attachment compressed (as ZIP tools do), one of them forged to claim 10 bytes.
    const victim = files[0]
    const rezipped = entries.map((e) => (e.name.startsWith('attachments/') ? deflatedEntry(e.name, e.data) : e)).map((e) => (e.name === victim.name ? { ...e, size: 10 } : e))
    // The manifest must agree on the forged size, or the size check refuses it before unpacking.
    const manifest = manifestOf()
    manifest.files = manifest.files.map((f) => (f.path === victim.name ? { ...f, size: 10 } : f))
    const archive = rawZip(rezipped.map((e) => (e.name === 'manifest.json' ? deflatedEntry('manifest.json', json(manifest)) : e)))
    const seen = await refused(archive, /damaged/)
    // Manifest, records, and attachments up to (and including) the forged one — never more, never twice.
    expect(seen.inflaters).toBeLessThanOrEqual(2 + files.length)
    expect(seen.bytesOut).toBeLessThanOrEqual(entries.reduce((n, e) => n + e.size, 0) + MiB + 64 * 1024)
  })

  it('two attachments may not share one file, so no file is unpacked twice', async () => {
    const manifest = manifestOf()
    const [first, second] = manifest.files
    manifest.files = manifest.files.map((f) => (f === second ? { ...f, path: first.path } : f))
    const archive = rawZip(entries.map((e) => (e.name === 'manifest.json' ? deflatedEntry('manifest.json', json(manifest)) : e)))
    await refused(archive, /lists an invalid file for attachment/)
  })
})

describe('good backups, and backups zipped again with a ZIP tool', () => {
  it('a good backup costs exactly two bounded decompressions: manifest.json and records.json', async () => {
    const result = await readArchive(good)
    expect(result.ok).toBe(true)
    expect(work.inflaters).toBe(2)
    expect(work.bytesOut).toBe(entry('manifest.json').size + entry('records.json').size)
    expect(work.compressedBytesIn).toBe(entry('manifest.json').data.length + entry('records.json').data.length)
    expect(work.bulkCalls).toBe(0)
    // README.txt is never unpacked, and attachments are stored (read in place).
    expect(entry('README.txt').method).toBe(8)
    for (const e of attachments()) expect(e.method).toBe(0)
  })

  const repacks: [string, () => Uint8Array][] = [
    ['data descriptors (macOS Archive Utility, Java, .NET)', () => rawZip(entries.map((e) => streamed({ ...e, flags: 0x0800 })))],
    ['extra fields and an archive comment (Info-ZIP)', () => rawZip(entries.map((e) => ({ ...e, localExtra: extraField(0x5455, new Uint8Array(9)), centralExtra: extraField(0x5455, new Uint8Array(5)) })), null, { comment: strToU8('zipped again') })],
    ['folder entries and leftovers of a Mac (all ignored, never unpacked)', () => rawZip([storedEntry('attachments/', new Uint8Array(0)), ...entries, deflatedEntry('__MACOSX/._records.json', strToU8('AppleDouble')), storedEntry('.DS_Store', new Uint8Array(8))])],
    ['every attachment compressed', () => rawZip(entries.map((e) => (e.name.startsWith('attachments/') ? deflatedEntry(e.name, e.data) : e)))],
    ['ZIP64 sizes in the headers (Python with force_zip64)', () => rawZip(entries.map((e) => ({ ...e, local: { compressedSize: 0xffffffff, size: 0xffffffff }, localExtra: zip64Field(e.size, e.data.length) })))],
  ]

  it.each(repacks)('%s: restores the same records and files, each file unpacked once', async (_label, make) => {
    const original = await readArchive(good)
    if (!original.ok) throw new Error(original.errors.join())
    resetWork()
    const archive = make()
    const result = await readArchive(archive)
    if (!result.ok) throw new Error(result.errors.join('\n'))
    expect(result.records).toEqual(original.records)
    for (const [id, blob] of original.blobs) expect(await sha256Hex(new Uint8Array(await result.blobs.get(id)!.arrayBuffer()))).toBe(await sha256Hex(new Uint8Array(await blob.arrayBuffer())))
    const compressed = rawEntriesOf(archive).filter((e) => e.method === 8 && (e.name === 'manifest.json' || e.name === 'records.json' || e.name.startsWith('attachments/')))
    expect(work.inflaters).toBe(compressed.length)
    expect(work.bulkCalls).toBe(0)
  })
})

describe('a refused backup changes nothing', () => {
  it('the workspace stays exactly as it was after each refused file', async () => {
    const src = await sourceWorkspace()
    const before = await src.store.repository.readAll()
    const hostile = [
      rawZip(Array.from({ length: 8 }, () => deflatedEntry('manifest.json', new Uint8Array(256 * 1024)))),
      rawZip([{ ...deflatedEntry('manifest.json', new Uint8Array(4 * MiB)), size: 8 }, ...others('manifest.json')]),
      rawZip([...entries, storedEntry('../evil.txt', strToU8('x'))]),
      rawZip(entries.map((e) => (e.name === 'records.json' ? { ...e, local: { crc: 1 } } : e))),
      good.subarray(0, good.length - 5),
    ]
    for (const bytes of hostile) expect((await readArchive(bytes)).ok).toBe(false)
    const after = await src.store.repository.readAll()
    expect(after.revision).toBe(before.revision)
    expect(after.records).toEqual(before.records)
    expect([...after.blobs.keys()].sort()).toEqual([...before.blobs.keys()].sort())
    expect(src.store.getState().data.revision).toBe(before.revision)
  })
})
