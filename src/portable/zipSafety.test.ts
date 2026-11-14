import { deflateSync, strToU8, zipSync } from 'fflate'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildArchive } from '../backup/archive'
import { centralRecord, concatBytes, crcOf, declareSize, deflatedEntry, destinationWorkspace, endRecord, localRecord, rawEntriesOf, rawZip, sourceWorkspace, storedEntry, type RawEntry } from '../test/portableFixtures'
import { PACKAGE_LIMITS } from './format'
import { buildProjectExport, importProjectPackage, loadExportSnapshot } from './projectTransfer'
import { readProjectPackage } from './readPackage'
import { DEFAULT_EXPORT_OPTIONS } from './selectProject'
import { crc32, entryBytes, readZipDirectory } from '../backup/zipReader'

/**
 * ZIP safety of the package reader (the file is hostile until proven otherwise).
 *
 * Every way the ZIP library can decompress is counted here, so a test can state
 * that an archive was refused WITHOUT anything being decompressed — not merely
 * that it was refused in the end.
 */
const work = vi.hoisted(() => ({ inflaters: 0, compressedBytesIn: 0, bytesOut: 0, bulkCalls: 0 }))

vi.mock('fflate', async (original) => {
  const real = await original<typeof import('fflate')>()
  class CountingInflate extends real.Inflate {
    private sink: ((chunk: Uint8Array, final: boolean) => void) | undefined
    constructor() {
      super()
      work.inflaters++
      // The reader assigns `ondata` afterwards; whatever it assigns is counted on the way through.
      Object.defineProperty(this, 'ondata', {
        configurable: true,
        get: () => (chunk: Uint8Array, final: boolean) => {
          work.bytesOut += chunk.byteLength
          this.sink?.(chunk, final)
        },
        set: (fn: (chunk: Uint8Array, final: boolean) => void) => {
          this.sink = fn
        },
      })
    }
    push(chunk: Uint8Array, final?: boolean) {
      work.compressedBytesIn += chunk.byteLength
      super.push(chunk, final)
    }
  }
  const counted =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      work.bulkCalls++
      return fn(...args)
    }
  // None of the bulk calls may ever happen: every archive is read through the bounded reader.
  return { ...real, Inflate: CountingInflate, unzip: counted(real.unzip), unzipSync: counted(real.unzipSync), inflateSync: counted(real.inflateSync), inflate: counted(real.inflate), decompressSync: counted(real.decompressSync), decompress: counted(real.decompress) }
})

let good: Uint8Array
let entries: RawEntry[]
const MiB = 1024 * 1024
const entry = (name: string) => entries.find((e) => e.name === name)!
const without = (...names: string[]) => entries.filter((e) => !names.includes(e.name))
const json = (value: unknown) => strToU8(JSON.stringify(value))

beforeAll(async () => {
  const src = await sourceWorkspace()
  good = (await buildProjectExport(await loadExportSnapshot(src.store), src.project.id, DEFAULT_EXPORT_OPTIONS, 'test')).bytes
  entries = rawEntriesOf(good)
})

beforeEach(() => {
  work.inflaters = work.compressedBytesIn = work.bytesOut = work.bulkCalls = 0
})

/** Refused with `reason`; returns what the ZIP library was asked to do meanwhile. */
async function refused(bytes: Uint8Array, reason: RegExp) {
  work.inflaters = work.compressedBytesIn = work.bytesOut = work.bulkCalls = 0
  const result = await readProjectPackage(bytes)
  expect(result.ok, result.ok ? 'the package was accepted' : result.errors.join(' | ')).toBe(false)
  expect((result.ok ? [] : result.errors).join(' | ')).toMatch(reason)
  return { ...work }
}

const NOTHING_DECOMPRESSED = { inflaters: 0, compressedBytesIn: 0, bytesOut: 0, bulkCalls: 0 }

describe('the hand-made archives are faithful', () => {
  it('a package rebuilt record by record holds the same entries as the exported one, and is accepted', async () => {
    // (Only the file times differ: the hand-made writer leaves them empty.)
    expect(rawZip(entries).length).toBe(good.length)
    expect(rawEntriesOf(rawZip(entries))).toEqual(entries)
    expect(crcOf(strToU8('minty'))).toBe(crc32(strToU8('minty')))
    const result = await readProjectPackage(rawZip(entries))
    expect(result.ok).toBe(true)
  })

  it('a good package costs two bounded decompressions of its own (manifest, project.json), plus one bounded check per compressed part of a Word original', async () => {
    const result = await readProjectPackage(good)
    expect(result.ok).toBe(true)
    // The imported DOCX travels stored, so its entry's data is the Word file; every compressed part of it is
    // unpacked once, within its recorded size, to prove the file is a real Word document (and nothing more).
    const docxParts = rawEntriesOf(entries.find((e) => e.name.endsWith('.docx'))!.data).filter((part) => part.method === 8)
    expect(docxParts.length).toBeGreaterThan(0)
    expect(work.inflaters).toBe(2 + docxParts.length)
    expect(work.compressedBytesIn).toBe(entry('manifest.json').data.length + entry('project.json').data.length + docxParts.reduce((n, part) => n + part.data.length, 0))
    expect(work.bytesOut).toBe(entry('manifest.json').size + entry('project.json').size + docxParts.reduce((n, part) => n + part.size, 0))
    expect(work.bulkCalls).toBe(0)
    // README.txt is never unpacked, and attachments are stored (read in place).
    expect(entry('README.txt').method).toBe(8)
    for (const e of entries.filter((x) => x.name.startsWith('attachments/'))) expect(e.method).toBe(0)
  })
})

describe('finding 1: nothing is decompressed before the directory has been checked', () => {
  it('eight manifests that each inflate to 256 KiB are refused without inflating one of them', async () => {
    // The audited case: a tiny file whose directory names manifest.json eight times.
    const manifest = deflatedEntry('manifest.json', new Uint8Array(256 * 1024))
    const bomb = rawZip(Array.from({ length: 8 }, () => manifest))
    expect(bomb.length).toBeLessThan(4096)
    expect(await refused(bomb, /"manifest.json" more than once/)).toEqual(NOTHING_DECOMPRESSED)
  })

  it('a duplicate of any entry — manifest, project data, attachment — is refused before anything is unpacked', async () => {
    for (const name of ['manifest.json', 'project.json', 'attachments/0001.pdf', 'README.txt']) {
      const twice = rawZip([...entries, entry(name)])
      expect(await refused(twice, new RegExp(`"${name.replace('.', '\\.')}" more than once`)), name).toEqual(NOTHING_DECOMPRESSED)
    }
    // A real manifest first and a second one behind it: readers disagree about which counts, so neither does.
    const second = deflatedEntry('manifest.json', json({ format: 'minty-notes-backup' }))
    expect(await refused(rawZip([...entries, second]), /more than once/)).toEqual(NOTHING_DECOMPRESSED)
    expect(await refused(rawZip([second, ...entries]), /more than once/)).toEqual(NOTHING_DECOMPRESSED)
  })

  it('names that differ only by case, and unsafe paths, are refused before anything is unpacked', async () => {
    expect(await refused(rawZip([...entries, deflatedEntry('Manifest.JSON', json({}))]), /differ only by letter case/)).toEqual(NOTHING_DECOMPRESSED)
    expect(await refused(rawZip([...entries, storedEntry('../manifest.json', json({}))]), /unsafe file path/)).toEqual(NOTHING_DECOMPRESSED)
  })

  it('too many entries are refused from the count alone', async () => {
    const empty = storedEntry('attachments/0.png', new Uint8Array(0))
    const many = [deflatedEntry('manifest.json', new Uint8Array(4 * MiB)), ...Array.from({ length: PACKAGE_LIMITS.entries }, (_, i) => ({ ...empty, name: `attachments/${i}.png` }))]
    expect(await refused(rawZip(many), /more than 20,000 files/)).toEqual(NOTHING_DECOMPRESSED)
    // A count that the directory itself does not back up is refused as well.
    const lying = concatBytes(localRecord(empty), centralRecord(empty, 0), endRecord(30_000, centralRecord(empty, 0).length, localRecord(empty).length))
    expect(await refused(lying, /more than 20,000 files/)).toEqual(NOTHING_DECOMPRESSED)
  })

  it('an unexpected file is refused after reading exactly one manifest — and a workspace backup is still named as one', async () => {
    const extra = await refused(rawZip([...entries, deflatedEntry('run-me.exe', new Uint8Array(MiB))]), /a file Minty Notes did not put there \("run-me.exe"\)/)
    expect(extra.inflaters).toBe(1)
    expect(extra.bytesOut).toBe(entry('manifest.json').size)

    const dest = await destinationWorkspace()
    const { records, blobs } = await dest.repo.readAll()
    const seen = await refused(await buildArchive(records, blobs, 'test'), /full workspace backup, not a project package/)
    expect(seen.inflaters).toBe(1)
    expect(seen.bulkCalls).toBe(0)
  })

  it('a manifest that is too large is not unpacked to find out what it is', async () => {
    const large = deflatedEntry('manifest.json', new Uint8Array(PACKAGE_LIMITS.manifestBytes + 1))
    expect(await refused(rawZip([large, ...without('manifest.json')]), /manifest is too large/)).toEqual(NOTHING_DECOMPRESSED)
  })
})

describe('finding 2: sizes written in the archive are never trusted on their own', () => {
  const big = () => {
    // A syntactically valid 9 MiB manifest (the audited case).
    const text = strToU8(JSON.stringify({ format: 'minty-notes-project', padding: '' }))
    const out = new Uint8Array(9 * MiB).fill(0x20)
    out.set(text, 0)
    return out
  }

  it('a 9 MiB stored manifest that claims to be one byte is refused, however the lie is told', async () => {
    const content = big()
    const rest = without('manifest.json')
    const honest = storedEntry('manifest.json', content)
    // Honest sizes: simply too large.
    expect(await refused(rawZip([honest, ...rest]), /manifest is too large/)).toEqual(NOTHING_DECOMPRESSED)
    // Unpacked size forged to 1 in both records (the directory and the header before the data).
    expect(await refused(rawZip([{ ...honest, size: 1 }, ...rest]), /sizes recorded for "manifest.json" contradict each other/)).toEqual(NOTHING_DECOMPRESSED)
    // Forged in the directory only.
    const directoryOnly = rawZip([honest, ...rest], (offsets) => [{ ...honest, size: 1 }, ...rest].map((e, i) => centralRecord(e, offsets[i])))
    expect(await refused(directoryOnly, /"manifest.json" contradict each other/)).toEqual(NOTHING_DECOMPRESSED)
    // Both sizes forged to 1: the other 9 MiB then belong to no file.
    expect(await refused(rawZip([{ ...honest, size: 1, compressedSize: 1 }, ...rest]), /list of files is damaged|data that belongs to no file|contradict/)).toEqual(NOTHING_DECOMPRESSED)
    // The same forgery with fflate's own writer and the directory patched afterwards.
    const patched = declareSize(zipSync({ 'manifest.json': [content, { level: 0 }] }), 'manifest.json', 1)
    expect(await refused(patched, /contradict each other/)).toEqual(NOTHING_DECOMPRESSED)
  })

  it('a stored project.json cannot hide its size either', async () => {
    const content = new Uint8Array(3 * MiB).fill(0x20)
    const rest = without('project.json')
    const stored = storedEntry('project.json', content)
    expect(await refused(rawZip([{ ...stored, size: 10 }, ...rest]), /sizes recorded for "project.json" contradict each other/)).toEqual(NOTHING_DECOMPRESSED)
    // Honest but not what the manifest lists: refused after the manifest, before project.json is touched.
    const seen = await refused(rawZip([stored, ...rest]), /project.json does not match its checksum/)
    expect(seen.inflaters).toBe(1)
    // Larger than the limit, stated honestly (the limit is on real bytes: a stored entry is as long as it says).
    const limit = { ...stored, size: PACKAGE_LIMITS.recordsBytes + 1, compressedSize: PACKAGE_LIMITS.recordsBytes + 1 }
    expect(await refused(rawZip([limit, ...rest]), /list of files is damaged|more than the 128 MB limit/)).toEqual(NOTHING_DECOMPRESSED)
  })

  it('a compressed manifest is unpacked only as far as it declared, and must come out exactly that long', async () => {
    const rest = without('manifest.json')
    const real = deflatedEntry('manifest.json', big().subarray(0, 6 * MiB))
    // Declares 100 bytes, inflates to 6 MiB: stopped in the first step.
    const more = await refused(rawZip([{ ...real, size: 100 }, ...rest]), /"manifest.json" unpacks to more than the package records for it/)
    expect(more.inflaters).toBe(1)
    expect(more.compressedBytesIn).toBeLessThanOrEqual(16 * 1024)
    // Declares more than it holds.
    const small = deflatedEntry('manifest.json', json({ format: 'minty-notes-project' }))
    const less = await refused(rawZip([{ ...small, size: small.size + 500 }, ...rest]), /"manifest.json" unpacks to less than the package records for it/)
    expect(less.inflaters).toBe(1)
    // Declares more than deflate could ever produce from so few bytes: not inflated at all.
    expect(await refused(rawZip([{ ...small, size: 7 * MiB }, ...rest]), /sizes recorded for "manifest.json" contradict each other/)).toEqual(NOTHING_DECOMPRESSED)
    // Declares more than the limit.
    expect(await refused(rawZip([{ ...real, size: PACKAGE_LIMITS.manifestBytes + 1 }, ...rest]), /manifest is too large/)).toEqual(NOTHING_DECOMPRESSED)
    // Right length, wrong contents for its ZIP checksum.
    await refused(rawZip([{ ...small, crc: small.crc ^ 1 }, ...rest]), /"manifest.json" does not match its ZIP checksum/)
    // Compressed data that is cut off or is not deflate at all.
    await refused(rawZip([{ ...small, data: small.data.slice(0, -4) }, ...rest]), /"manifest.json" could not be unpacked/)
    await refused(rawZip([{ ...small, data: new Uint8Array(40).fill(0xff) }, ...rest]), /"manifest.json" could not be unpacked/)
  })

  it('a compressed project.json is held to the same rules', async () => {
    const rest = without('project.json')
    const original = entry('project.json')
    // A real bomb: 20 MiB of spaces that claims to be as long as the real project data.
    const bomb = { ...deflatedEntry('project.json', new Uint8Array(20 * MiB).fill(0x20)), size: original.size }
    const seen = await refused(rawZip([bomb, ...rest]), /"project.json" unpacks to more than the package records for it/)
    expect(seen.inflaters).toBe(2) // the manifest, then project.json
    // Nothing beyond the declared size is ever kept; at most one step's worth is produced past it.
    expect(seen.compressedBytesIn - entry('manifest.json').data.length).toBeLessThanOrEqual(Math.ceil(original.size / 1000 / (16 * 1024) + 1) * 16 * 1024)
    // Sizes that disagree with the manifest are refused before project.json is unpacked.
    const other = deflatedEntry('project.json', new Uint8Array(original.size + 1).fill(0x20))
    expect((await refused(rawZip([other, ...rest]), /project.json does not match its checksum/)).inflaters).toBe(1)
    // Over the limit by declaration: refused from the directory. Only the (one, bounded) manifest was read, to tell a backup from a package.
    const onlyTheManifest = { inflaters: 1, compressedBytesIn: entry('manifest.json').data.length, bytesOut: entry('manifest.json').size, bulkCalls: 0 }
    expect(await refused(rawZip([{ ...original, size: PACKAGE_LIMITS.recordsBytes + 1 }, ...rest]), /project data would unpack to 128 MB, more than the 128 MB limit/)).toEqual(onlyTheManifest)
    expect(await refused(declareSize(good, 'project.json', PACKAGE_LIMITS.recordsBytes + 1), /more than the 128 MB limit/)).toEqual(onlyTheManifest)
  })

  it('attachments must be stored, exactly as long as recorded, each in its own place', async () => {
    const pdf = entry('attachments/0001.pdf')
    const rest = without(pdf.name)
    expect(await refused(rawZip([{ ...pdf, size: pdf.size + 1_000_000_000 }, ...rest]), /sizes recorded for "attachments\/0001.pdf" contradict each other/)).toEqual(NOTHING_DECOMPRESSED)
    expect(await refused(declareSize(good, pdf.name, 1_900_000_000), /contradict each other/)).toEqual(NOTHING_DECOMPRESSED)
    // Compressed attachments are a repack; they are not inflated to see what is inside.
    const packed = { ...deflatedEntry(pdf.name, new Uint8Array(50 * MiB)) }
    const seen = await refused(rawZip([packed, ...rest]), /was repacked: "attachments\/0001.pdf" is compressed/)
    expect(seen.inflaters).toBe(1) // only the manifest
    expect(seen.bytesOut).toBe(entry('manifest.json').size)
  })

  it('entries may not overlap, hide data between them, or disagree with the header in front of their data', async () => {
    const a = entry('attachments/0001.pdf')
    const b = entry('attachments/0002.docx')
    const rest = without(a.name, b.name)
    const ordered = [a, b, ...rest]
    // Two directory records for the same bytes (one small file listed as many).
    const sameData = rawZip(ordered, (offsets) => ordered.map((e, i) => centralRecord(i === 1 ? { ...a, name: b.name } : e, offsets[i === 1 ? 0 : i])))
    expect(await refused(sameData, /two records of "attachments\/0002.docx" contradict each other/)).toEqual(NOTHING_DECOMPRESSED)
    // One entry laid inside another one's data.
    const inner = storedEntry('attachments/0009.png', new Uint8Array(64))
    const outer = storedEntry(a.name, concatBytes(new Uint8Array(100), localRecord(inner), new Uint8Array(100)))
    const nested = [outer, ...rest]
    const overlapping = rawZip(nested, (offsets) => [...nested.map((e, i) => centralRecord(e, offsets[i])), centralRecord(inner, 30 + a.name.length + 100)])
    expect(await refused(overlapping, /two of its files overlap/)).toEqual(NOTHING_DECOMPRESSED)
    // Data in front of the first entry, or between entries, that the directory does not list.
    const hidden = rawZip(ordered, (offsets) => ordered.slice(1).map((e, i) => centralRecord(e, offsets[i + 1])))
    expect(await refused(hidden, /data that belongs to no file/)).toEqual(NOTHING_DECOMPRESSED)
    // The header before the data names another file, or another method.
    const renamed = rawZip(ordered, (offsets) => ordered.map((e, i) => centralRecord(i === 0 ? { ...e, name: 'attachments/0007.pdf' } : e, offsets[i])))
    expect(await refused(renamed, /contradict each other/)).toEqual(NOTHING_DECOMPRESSED)
    const manifest = entry('manifest.json')
    const method = rawZip(entries, (offsets) => entries.map((e, i) => centralRecord(e === manifest ? { ...e, method: 0, size: e.data.length } : e, offsets[i])))
    expect(await refused(method, /contradict each other/)).toEqual(NOTHING_DECOMPRESSED)
  })

  it('ZIP features a package never uses are refused: comments, ZIP64, encryption, sizes after the data, other methods', async () => {
    const body = good.subarray(0, good.length - 22)
    const end = good.subarray(good.length - 22)
    const withComment = concatBytes(body, end, strToU8('hello'))
    new DataView(withComment.buffer).setUint16(body.length + 20, 5, true)
    expect(await refused(withComment, /not written by Minty Notes.*ends with a comment/)).toEqual(NOTHING_DECOMPRESSED)
    expect(await refused(concatBytes(good, strToU8('trailing bytes after the archive')), /list of files is damaged or was cut off/)).toEqual(NOTHING_DECOMPRESSED)
    const flagged = (flags: number) => rawZip(entries.map((e) => (e.name === 'manifest.json' ? { ...e, flags } : e)))
    expect(await refused(flagged(1), /uses a ZIP feature that packages never use/)).toEqual(NOTHING_DECOMPRESSED) // encrypted
    expect(await refused(flagged(8), /uses a ZIP feature that packages never use/)).toEqual(NOTHING_DECOMPRESSED) // sizes written after the data
    expect(await refused(rawZip(entries.map((e) => (e.name === 'README.txt' ? { ...e, method: 9 } : e))), /unsupported compression method/)).toEqual(NOTHING_DECOMPRESSED)
    expect(await refused(rawZip(entries.map((e) => (e.name === 'README.txt' ? { ...e, size: 0xffffffff } : e))), /ZIP64/)).toEqual(NOTHING_DECOMPRESSED)
  })

  it('the low-level reader keeps its promises on its own', async () => {
    const content = new Uint8Array(3 * MiB).fill(0x41)
    const zip = rawZip([deflatedEntry('a.json', content), storedEntry('b.bin', content.subarray(0, 1000))])
    const dir = readZipDirectory(zip, 10)
    if (!dir.ok) throw new Error(dir.detail)
    expect(work).toEqual(NOTHING_DECOMPRESSED)
    const [a, b] = dir.entries
    // Stored: a view of the archive's own bytes (no copy), exactly as long as recorded.
    const stored = await entryBytes(zip, b, 1000)
    expect(stored.buffer).toBe(zip.buffer)
    expect(stored.byteLength).toBe(1000)
    await expect(entryBytes(zip, b, 999)).rejects.toThrow(/larger than Minty Notes accepts/)
    // Deflated: the caller's limit applies before a single byte is inflated.
    work.inflaters = 0
    await expect(entryBytes(zip, a, 3 * MiB - 1)).rejects.toThrow(/larger than Minty Notes accepts/)
    expect(work.inflaters).toBe(0)
    const unpacked = await entryBytes(zip, a, 3 * MiB)
    expect([unpacked.byteLength, crc32(unpacked)]).toEqual([content.byteLength, crc32(content)])
    expect(readZipDirectory(zip, 1)).toMatchObject({ ok: false, reason: 'too-many' })
    expect(readZipDirectory(deflateSync(content), 10)).toMatchObject({ ok: false, reason: 'not-zip' })
  })
})

describe('a refused archive changes nothing', () => {
  it('none of these files reaches the workspace', async () => {
    const dest = await destinationWorkspace()
    const before = JSON.stringify((await dest.repo.readAll()).records)
    const manifest = deflatedEntry('manifest.json', new Uint8Array(256 * 1024))
    for (const bytes of [rawZip(Array.from({ length: 8 }, () => manifest)), rawZip([{ ...storedEntry('manifest.json', new Uint8Array(9 * MiB)), size: 1 }, ...without('manifest.json')])]) {
      const result = await readProjectPackage(bytes)
      expect(result.ok).toBe(false)
      // An invalid result carries no records, so there is nothing an import could be given.
      expect('records' in result).toBe(false)
      await expect(importProjectPackage(dest.store, result as never)).rejects.toThrow()
    }
    expect(JSON.stringify((await dest.repo.readAll()).records)).toBe(before)
  })
})
