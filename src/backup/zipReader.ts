import { Inflate } from 'fflate'

/**
 * One ZIP reader for every untrusted archive the app opens: workspace backups
 * (restore), Word documents (import, and imported originals inside project
 * packages), and portable project packages.
 *
 * It works in two separate steps, whatever the layout:
 *
 *   1. `readZipDirectory` reads only the directory and the fixed-size headers.
 *      It never decompresses and never copies entry data, so its cost is
 *      bounded by the size of the directory, whatever the archive claims. The
 *      directory, the header in front of each entry's data, the entry ranges,
 *      and the end records must agree with one another and with the file.
 *   2. `entryBytes` (or `checkEntry`) unpacks ONE entry the caller has already
 *      approved, within a limit the caller passes. A stored entry is a view of
 *      the file's own bytes; a deflated entry is inflated a little at a time
 *      and refused as soon as it produces more than the archive recorded (at
 *      most about 1 MiB more is ever produced) — or, at the end, one byte
 *      less, or bytes whose CRC differs. Memory grows with the bytes really
 *      produced, never with what the archive merely claims.
 *
 * Sizes written in an archive are therefore never trusted on their own.
 *
 * Two layouts are accepted:
 *   - `minty`: exactly what Minty Notes' own ZIP writer produces (fflate's
 *     `zip`: no ZIP64, no encryption, no data descriptors, no extra fields, no
 *     comments, entries one after another from the first byte). Used for
 *     project packages, which must be used exactly as exported.
 *   - `standard`: any well-formed single-volume ZIP, including what other
 *     writers produce: data descriptors, extra fields (e.g. Word's padding),
 *     comments, gaps between entries, and ZIP64 records. Used for backups
 *     (which may have been unpacked and zipped again with a ZIP tool) and for
 *     Word documents (written by many programs). Encrypted entries, archives
 *     split over several volumes, and overlapping entries are still refused,
 *     and only stored and deflated entries can be unpacked.
 */

export type ZipLayout = 'minty' | 'standard'

export interface ZipEntry {
  name: string
  /** 0 = stored as it is, 8 = deflate. Other methods are only listed by the `standard` layout and cannot be unpacked. */
  method: number
  /** General-purpose flags from the directory. */
  flags: number
  /** Bytes the entry occupies in the file. */
  compressedSize: number
  /** Bytes the entry unpacks to (equal to `compressedSize` for a stored entry). */
  size: number
  crc32: number
  /** Where the header in front of the entry's data starts. */
  headerStart: number
  /** Where the entry's data starts in the file. */
  dataStart: number
}

/**
 * Why a directory was refused: not a ZIP at all; damaged or cut off (data
 * missing, or records that point outside the file); a structure that is not
 * accepted here (contradicting records, overlaps, encryption, volumes, or —
 * for `minty` — anything the app's writer does not produce); or more entries
 * than the caller allows (judged from the end record alone).
 */
export type ZipProblem = 'not-zip' | 'incomplete' | 'foreign' | 'too-many'

export type ZipDirectory = { ok: true; entries: ZipEntry[] } | { ok: false; reason: ZipProblem; detail: string; count?: number }

const EOCD = 0x06054b50
const EOCD64 = 0x06064b50
const LOCATOR64 = 0x07064b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const EOCD_SIZE = 22
const LOCATOR64_SIZE = 20
const EOCD64_SIZE = 56
const CENTRAL_SIZE = 46
const LOCAL_SIZE = 30
const MAX16 = 0xffff
const MAX32 = 0xffffffff
/** Encryption (bits 0, 6, 13) and patch data (bit 5) change what an entry's bytes mean: such entries cannot be read. */
const UNREADABLE_FLAGS = 0x0001 | 0x0020 | 0x0040 | 0x2000
const DATA_DESCRIPTOR = 0x0008
const UTF8_NAME = 0x0800
/** Deflate cannot expand by more than about 1032 times. */
const MAX_DEFLATE_RATIO = 1032
/** Compressed bytes handed to the inflater at a time, at most (one step can then produce about 16 MiB). */
const INFLATE_STEP = 16 * 1024
/**
 * How far past its recorded size an entry can be inflated before it is
 * refused. Steps shrink as an entry approaches its recorded size (to about
 * 1 KiB), so that one step can never produce more than what is still missing
 * plus this much — whatever the data, since deflate expands at most 1032×.
 */
const OVERSHOOT_BUDGET = 1024 * 1024
/** Let the page breathe after this much output. */
const YIELD_EVERY = 8 * 1024 * 1024
/** First output buffer for a deflated entry, at least; it then doubles as real output arrives, up to the recorded size. */
const FIRST_BUFFER = 256 * 1024

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** Byte-for-byte (ISO-8859-1), for names that are not valid UTF-8 and do not claim to be. */
function latin1(raw: Uint8Array): string {
  let text = ''
  for (let i = 0; i < raw.length; i++) text += String.fromCharCode(raw[i])
  return text
}

/**
 * Read and check the directory of a ZIP. No entry data is read, copied, or
 * decompressed. Refuses more than `maxEntries` entries before looking at any
 * of them.
 */
export function readZipDirectory(bytes: Uint8Array, maxEntries: number, layout: ZipLayout = 'minty'): ZipDirectory {
  const strict = layout === 'minty'
  const bad = (reason: ZipProblem, detail: string): ZipDirectory => ({ ok: false, reason, detail })
  const length = bytes.byteLength
  if (length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return bad('not-zip', 'it is not a ZIP archive')
  if (length < EOCD_SIZE) return bad('incomplete', 'it is too short to hold a list of files')
  const view = new DataView(bytes.buffer, bytes.byteOffset, length)
  const u16 = (o: number) => view.getUint16(o, true)
  const u32 = (o: number) => view.getUint32(o, true)
  /** A 64-bit value, or -1 when it is beyond what can be addressed exactly (no real file is that large). */
  const u64 = (o: number) => {
    const high = u32(o + 4)
    return high >= 0x200000 ? -1 : high * 0x100000000 + u32(o)
  }

  // ---- the end record (and, for `standard`, the ZIP64 end record it may point to)
  let end = length - EOCD_SIZE
  if (strict) {
    if (u32(end) !== EOCD || u16(end + 20) !== 0) {
      // A complete ZIP that ends with a comment is somebody else's archive; anything else is cut off or damaged.
      for (let o = end - 1, stop = Math.max(0, end - MAX16); o >= stop; o--) {
        if (u32(o) === EOCD && o + EOCD_SIZE + u16(o + 20) === length) return bad('foreign', 'it ends with a comment')
      }
      return bad('incomplete', 'the end of its list of files is missing')
    }
  } else {
    // The end record may be followed by a comment, which must reach exactly to the end of the file.
    // Two records that both fit would let two readers see two different archives: refused.
    const found: number[] = []
    for (let o = end, stop = Math.max(0, end - MAX16); o >= stop; o--) {
      if (u32(o) === EOCD && o + EOCD_SIZE + u16(o + 20) === length) found.push(o)
    }
    if (found.length === 0) return bad('incomplete', 'the end of its list of files is missing')
    if (found.length > 1) return bad('foreign', 'it has more than one end record')
    end = found[0]
  }
  let disk = u16(end + 4)
  let directoryDisk = u16(end + 6)
  let onDisk = u16(end + 8)
  let count = u16(end + 10)
  let directorySize = u32(end + 12)
  let directoryStart = u32(end + 16)
  /** Where the directory must end: at the end record, or at the ZIP64 end record. */
  let directoryEnd = end
  if (strict) {
    if (disk !== 0 || directoryDisk !== 0 || onDisk !== count) return bad('foreign', 'it is split over several volumes')
    if (count === MAX16 || directorySize === MAX32 || directoryStart === MAX32) return bad('foreign', 'it uses the ZIP64 format')
  } else if (end >= LOCATOR64_SIZE && u32(end - LOCATOR64_SIZE) === LOCATOR64) {
    const locator = end - LOCATOR64_SIZE
    if (u32(locator + 4) !== 0 || u32(locator + 16) > 1) return bad('foreign', 'it is split over several volumes')
    const record = u64(locator + 8)
    if (record < 0 || record + EOCD64_SIZE > locator || u32(record) !== EOCD64) return bad('incomplete', 'its ZIP64 end record is missing')
    const recordSize = u64(record + 4)
    if (recordSize < EOCD64_SIZE - 12 || record + 12 + recordSize !== locator) return bad('incomplete', 'its ZIP64 end record is damaged')
    const big = { disk: u32(record + 16), directoryDisk: u32(record + 20), onDisk: u64(record + 24), count: u64(record + 32), directorySize: u64(record + 40), directoryStart: u64(record + 48) }
    if (big.onDisk < 0 || big.count < 0 || big.directorySize < 0 || big.directoryStart < 0) return bad('incomplete', 'its ZIP64 end record is damaged')
    // Each field of the ordinary end record either holds the ZIP64 marker or says the same as the ZIP64 record.
    const agree = (small: number, marker: number, value: number) => small === marker || small === value
    const consistent =
      agree(disk, MAX16, big.disk) && agree(directoryDisk, MAX16, big.directoryDisk) && agree(onDisk, MAX16, big.onDisk) && agree(count, MAX16, big.count) && agree(directorySize, MAX32, big.directorySize) && agree(directoryStart, MAX32, big.directoryStart)
    if (!consistent) return bad('foreign', 'its two end records contradict each other')
    ;({ disk, directoryDisk, onDisk, count, directorySize, directoryStart } = big)
    directoryEnd = record
  }
  if (!strict && (disk !== 0 || directoryDisk !== 0 || onDisk !== count)) return bad('foreign', 'it is split over several volumes')
  if (count > maxEntries) return { ok: false, reason: 'too-many', detail: `it lists ${count.toLocaleString('en-US')} files`, count }
  if (directoryStart + directorySize !== directoryEnd || count * CENTRAL_SIZE > directorySize) return bad('incomplete', 'its list of files is damaged or cut off')

  // ---- every directory record, and the header in front of each entry's data
  const entries: ZipEntry[] = []
  let o = directoryStart
  for (let i = 0; i < count; i++) {
    if (o + CENTRAL_SIZE > directoryEnd || u32(o) !== CENTRAL) return bad('incomplete', 'its list of files is damaged or cut off')
    const flags = u16(o + 8)
    const method = u16(o + 10)
    const crc32 = u32(o + 16)
    let compressedSize = u32(o + 20)
    let size = u32(o + 24)
    const nameLength = u16(o + 28)
    const extraLength = u16(o + 30)
    const commentLength = u16(o + 32)
    let diskStart = u16(o + 34)
    let headerStart = u32(o + 42)
    const next = o + CENTRAL_SIZE + nameLength + extraLength + commentLength
    if (next > directoryEnd) return bad('incomplete', 'its list of files is damaged or cut off')
    const rawName = bytes.subarray(o + CENTRAL_SIZE, o + CENTRAL_SIZE + nameLength)
    let name: string
    if (strict) {
      try {
        name = utf8.decode(rawName)
      } catch {
        return bad('incomplete', 'a file name is damaged')
      }
      // eslint-disable-next-line no-control-regex
      if (name.length === 0 || name.length > 300 || /[\u0000-\u001f\u007f\ufffd]/.test(name)) return bad('incomplete', 'a file name is damaged')
    } else {
      try {
        name = utf8.decode(rawName)
      } catch {
        if (flags & UTF8_NAME) return bad('foreign', 'a file name that claims to be UTF-8 is not')
        name = latin1(rawName)
      }
    }
    const shown = JSON.stringify(name.slice(0, 120))
    if (strict) {
      // Bit 11 only says the name is UTF-8. Everything else (encryption, sizes written after the data, …) is refused.
      if ((flags & ~UTF8_NAME) !== 0) return bad('foreign', `${shown} uses a ZIP feature that packages never use`)
      if (method !== 0 && method !== 8) return bad('foreign', `${shown} uses an unsupported compression method`)
      if (extraLength !== 0 || commentLength !== 0 || diskStart !== 0) return bad('foreign', `${shown} carries extra ZIP fields`)
      if (compressedSize === MAX32 || size === MAX32 || headerStart === MAX32) return bad('foreign', 'it uses the ZIP64 format')
    } else {
      if (flags & UNREADABLE_FLAGS) return bad('foreign', `${shown} is encrypted`)
      if (size === MAX32 || compressedSize === MAX32 || headerStart === MAX32 || diskStart === MAX16) {
        const big = zip64Values(view, o + CENTRAL_SIZE + nameLength, extraLength, [size === MAX32, compressedSize === MAX32, headerStart === MAX32, diskStart === MAX16])
        if (big === 'damaged') return bad('incomplete', `the ZIP64 sizes of ${shown} are damaged`)
        if (big) [size, compressedSize, headerStart, diskStart] = [big[0] ?? size, big[1] ?? compressedSize, big[2] ?? headerStart, big[3] ?? diskStart]
      }
      if (diskStart !== 0) return bad('foreign', 'it is split over several volumes')
    }
    if (method === 0 && compressedSize !== size) return bad('foreign', `the sizes recorded for ${shown} contradict each other`)

    // The header in front of the data must say the same as the directory, and lie inside the file, before the directory.
    if (headerStart + LOCAL_SIZE + nameLength > directoryStart || u32(headerStart) !== LOCAL) return bad('incomplete', `${shown} points outside the file`)
    const sameName = u16(headerStart + 26) === nameLength && rawName.every((b, k) => bytes[headerStart + LOCAL_SIZE + k] === b)
    let dataStart: number
    if (strict) {
      const sameFacts = u16(headerStart + 6) === flags && u16(headerStart + 8) === method && u32(headerStart + 14) === crc32 && u32(headerStart + 18) === compressedSize && u32(headerStart + 22) === size && u16(headerStart + 28) === 0
      if (!sameName || !sameFacts) return bad('foreign', `the two records of ${shown} contradict each other`)
      dataStart = headerStart + LOCAL_SIZE + nameLength
    } else {
      const localFlags = u16(headerStart + 6)
      const localExtraLength = u16(headerStart + 28)
      dataStart = headerStart + LOCAL_SIZE + nameLength + localExtraLength
      if (dataStart > directoryStart) return bad('incomplete', `${shown} points outside the file`)
      let localCompressed = u32(headerStart + 18)
      let localSize = u32(headerStart + 22)
      if (localCompressed === MAX32 || localSize === MAX32) {
        // A ZIP64 header in front of the data always carries both sizes.
        const big = zip64Values(view, headerStart + LOCAL_SIZE + nameLength, localExtraLength, [true, true])
        if (big === 'damaged') return bad('incomplete', `the ZIP64 sizes of ${shown} are damaged`)
        if (big) [localSize, localCompressed] = [big[0] ?? localSize, big[1] ?? localCompressed]
      }
      // With a data descriptor the sizes and CRC follow the data, and the header may hold zeros instead.
      const described = ((flags | localFlags) & DATA_DESCRIPTOR) !== 0
      const agrees = (local: number, central: number) => local === central || (described && local === 0)
      const sameFacts = u16(headerStart + 8) === method && (localFlags & UNREADABLE_FLAGS) === 0 && agrees(u32(headerStart + 14), crc32) && agrees(localCompressed, compressedSize) && agrees(localSize, size)
      if (!sameName || !sameFacts) return bad('foreign', `the two records of ${shown} contradict each other`)
    }
    if (dataStart + compressedSize > directoryStart) return bad('incomplete', `the data of ${shown} runs past the end of the file`)
    entries.push({ name, method, flags, compressedSize, size, crc32, headerStart, dataStart })
    o = next
  }
  if (o !== directoryEnd) return bad('incomplete', 'its list of files is damaged or cut off')

  // ---- the entries in the file: never overlapping (one piece of data listed as many files, or
  // one entry hidden inside another). `minty` also allows no gaps: nothing is hidden between them.
  const inFileOrder = [...entries].sort((a, b) => a.headerStart - b.headerStart)
  let reached = 0
  for (const e of inFileOrder) {
    if (e.headerStart < reached) return bad('foreign', 'two of its files overlap')
    if (strict && e.headerStart > reached) return bad('foreign', 'it contains data that belongs to no file')
    reached = e.dataStart + e.compressedSize
  }
  if (strict && reached !== directoryStart) return bad('foreign', 'it contains data that belongs to no file')
  return { ok: true, entries }
}

/**
 * The ZIP64 values of an extra field area: for each field that holds the
 * ZIP64 marker (`wanted`, in the order original size, compressed size, header
 * offset, disk), its 64-bit value. Returns null when the area has no ZIP64
 * record (the 32-bit values then stand as written), 'damaged' when it has one
 * that is too short or beyond what can be addressed.
 */
function zip64Values(view: DataView, start: number, length: number, wanted: boolean[]): (number | undefined)[] | 'damaged' | null {
  const stop = start + length
  for (let o = start; o + 4 <= stop; ) {
    const id = view.getUint16(o, true)
    const size = view.getUint16(o + 2, true)
    if (o + 4 + size > stop) return null
    if (id === 0x0001) {
      const values: (number | undefined)[] = []
      let at = o + 4
      for (let k = 0; k < wanted.length; k++) {
        if (!wanted[k]) {
          values.push(undefined)
          continue
        }
        const width = k === 3 ? 4 : 8
        if (at + width > o + 4 + size) return 'damaged'
        const high = width === 8 ? view.getUint32(at + 4, true) : 0
        if (high >= 0x200000) return 'damaged'
        values.push(high * 0x100000000 + view.getUint32(at, true))
        at += width
      }
      return values
    }
    o += 4 + size
  }
  return null
}

/** Thrown when an entry cannot be unpacked to exactly what the archive recorded for it. */
export class ZipEntryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipEntryError'
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crcUpdate(crc: number, data: Uint8Array): number {
  let c = crc
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return c
}

export function crc32(data: Uint8Array): number {
  return (crcUpdate(0xffffffff, data) ^ 0xffffffff) >>> 0
}

/**
 * The data of one entry from a checked directory.
 *
 * `maxBytes` is the most this entry may unpack to; the caller must pass it for
 * every entry it unpacks. `archive` names the archive in messages ("package",
 * "backup", "document"). A stored entry is returned as a view (no copy). A
 * deflated entry is inflated step by step: it is refused as soon as it would
 * exceed its recorded size, and afterwards if it came out shorter or its CRC
 * differs.
 */
export async function entryBytes(bytes: Uint8Array, entry: ZipEntry, maxBytes: number, archive = 'package'): Promise<Uint8Array> {
  return (await unpack(bytes, entry, maxBytes, archive, true)) as Uint8Array
}

/**
 * Check that one entry unpacks to exactly what the archive recorded for it
 * (size and CRC, also for a stored entry), within `maxBytes`, without keeping
 * the result: memory stays at one inflate step whatever the entry's size.
 */
export async function checkEntry(bytes: Uint8Array, entry: ZipEntry, maxBytes: number, archive: string): Promise<void> {
  await unpack(bytes, entry, maxBytes, archive, false)
}

async function unpack(bytes: Uint8Array, entry: ZipEntry, maxBytes: number, archive: string, keep: boolean): Promise<Uint8Array | null> {
  const shown = JSON.stringify(entry.name.slice(0, 120))
  if (entry.size > maxBytes) throw new ZipEntryError(`${shown} is larger than Minty Notes accepts.`)
  if (entry.method !== 0 && entry.method !== 8) throw new ZipEntryError(`${shown} uses a compression method Minty Notes cannot read.`)
  const data = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize)
  if (data.byteLength !== entry.compressedSize) throw new ZipEntryError(`${shown} is cut off.`)
  if (entry.method === 0) {
    if (!keep && crc32(data) !== entry.crc32) throw new ZipEntryError(`${shown} does not match its ZIP checksum.`)
    return keep ? data : null
  }
  // A compressed file much larger than the most it may unpack to is not worth inflating.
  if (entry.compressedSize > maxBytes + maxBytes / 8 + 1024) throw new ZipEntryError(`${shown} is larger than Minty Notes accepts.`)
  // More output than deflate can produce from that many bytes is a lie: refused without inflating anything.
  if (entry.size > entry.compressedSize * MAX_DEFLATE_RATIO + 512) throw new ZipEntryError(`the sizes recorded for ${shown} contradict each other.`)

  let out: Uint8Array | null = null
  let written = 0
  let crc = 0xffffffff
  const inflater = new Inflate()
  inflater.ondata = (chunk) => {
    const reach = written + chunk.byteLength
    if (reach > entry.size) throw new ZipEntryError(`${shown} unpacks to more than the ${archive} records for it.`)
    if (out) {
      if (reach > out.byteLength) {
        const grown = new Uint8Array(Math.min(entry.size, Math.max(reach, out.byteLength * 2)))
        grown.set(out.subarray(0, written))
        out = grown
      }
      out.set(chunk, written)
    }
    crc = crcUpdate(crc, chunk)
    written = reach
  }
  let sinceYield = 0
  try {
    if (keep) out = new Uint8Array(Math.min(entry.size, Math.max(FIRST_BUFFER, entry.compressedSize * 4)))
    for (let i = 0; i < data.byteLength || i === 0; ) {
      // Never hand over more than could produce what is still missing plus the overshoot budget.
      const step = Math.min(INFLATE_STEP, Math.ceil((entry.size - written + OVERSHOOT_BUDGET) / MAX_DEFLATE_RATIO))
      const before = written
      inflater.push(data.subarray(i, i + step), i + step >= data.byteLength)
      i += step
      sinceYield += written - before
      if (sinceYield >= YIELD_EVERY) {
        sinceYield = 0
        await new Promise((resume) => setTimeout(resume, 0))
      }
    }
  } catch (err) {
    if (err instanceof ZipEntryError) throw err
    throw new ZipEntryError(`${shown} could not be unpacked (${err instanceof Error ? err.message : String(err)}).`)
  }
  if (written !== entry.size) throw new ZipEntryError(`${shown} unpacks to less than the ${archive} records for it.`)
  if (((crc ^ 0xffffffff) >>> 0) !== entry.crc32) throw new ZipEntryError(`${shown} does not match its ZIP checksum.`)
  return out
}
