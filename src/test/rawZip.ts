import { deflateSync, strToU8 } from 'fflate'

/**
 * Hand-made ZIP archives for tests (pure; used by unit tests and by the
 * browser tests, which build hostile files in Node).
 */

const dec = new TextDecoder()

// ---------------------------------------------------------------- hand-made ZIPs
// fflate cannot write a hostile archive (the same name twice, sizes that lie,
// entries that overlap), so tests that need one assemble it record by record.

export interface RawEntry {
  name: string
  /** The bytes as they sit in the file (already deflated when `method` is 8). */
  data: Uint8Array
  method: number
  /** Unpacked size the archive records. */
  size: number
  crc: number
  /** Compressed size the archive records (default: the real length of `data`). */
  compressedSize?: number
  flags?: number
  // ---- what other ZIP writers do (all optional; without them the entry is written exactly as before)
  /** Extra fields in the header in front of the data (e.g. Word's 0xA220 padding). */
  localExtra?: Uint8Array
  /** Extra fields in the directory record. */
  centralExtra?: Uint8Array
  /** A comment in the directory record. */
  comment?: Uint8Array
  /** Bytes written right after the data (a data descriptor). */
  trailer?: Uint8Array
  /** Bytes written in front of the entry's header (padding between entries). */
  padding?: Uint8Array
  /** What the header in front of the data says, where it differs from the directory (e.g. zeros before a data descriptor). */
  local?: { flags?: number; method?: number; crc?: number; compressedSize?: number; size?: number; name?: string }
  /** The header offset the directory records, instead of the real one. */
  offset?: number
}

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crcOf(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** An entry stored as it is. */
export const storedEntry = (name: string, content: Uint8Array): RawEntry => ({ name, data: content, method: 0, size: content.byteLength, crc: crcOf(content) })
/** An entry compressed with deflate. */
export const deflatedEntry = (name: string, content: Uint8Array): RawEntry => ({ name, data: deflateSync(content), method: 8, size: content.byteLength, crc: crcOf(content) })

const none = new Uint8Array(0)

/** The header that precedes an entry's data, followed by the data (and its trailer, if any). Padding is not included. */
export function localRecord(e: RawEntry): Uint8Array {
  const name = strToU8(e.local?.name ?? e.name)
  const extra = e.localExtra ?? none
  const trailer = e.trailer ?? none
  const out = new Uint8Array(30 + name.length + extra.length + e.data.length + trailer.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, 0x04034b50, true)
  v.setUint16(4, 20, true)
  v.setUint16(6, e.local?.flags ?? e.flags ?? 0, true)
  v.setUint16(8, e.local?.method ?? e.method, true)
  v.setUint32(14, e.local?.crc ?? e.crc, true)
  v.setUint32(18, e.local?.compressedSize ?? e.compressedSize ?? e.data.length, true)
  v.setUint32(22, e.local?.size ?? e.size, true)
  v.setUint16(26, name.length, true)
  v.setUint16(28, extra.length, true)
  out.set(name, 30)
  out.set(extra, 30 + name.length)
  out.set(e.data, 30 + name.length + extra.length)
  out.set(trailer, 30 + name.length + extra.length + e.data.length)
  return out
}

/** The directory record of an entry whose local header is at `offset`. */
export function centralRecord(e: RawEntry, offset: number): Uint8Array {
  const name = strToU8(e.name)
  const extra = e.centralExtra ?? none
  const comment = e.comment ?? none
  const out = new Uint8Array(46 + name.length + extra.length + comment.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, 0x02014b50, true)
  v.setUint16(4, 20, true)
  v.setUint16(6, 20, true)
  v.setUint16(8, e.flags ?? 0, true)
  v.setUint16(10, e.method, true)
  v.setUint32(16, e.crc, true)
  v.setUint32(20, e.compressedSize ?? e.data.length, true)
  v.setUint32(24, e.size, true)
  v.setUint16(28, name.length, true)
  v.setUint16(30, extra.length, true)
  v.setUint16(32, comment.length, true)
  v.setUint32(42, e.offset ?? offset, true)
  out.set(name, 46)
  out.set(extra, 46 + name.length)
  out.set(comment, 46 + name.length + extra.length)
  return out
}

/** One extra field record: id, length, data. */
export function extraField(id: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + data.length)
  const v = new DataView(out.buffer)
  v.setUint16(0, id, true)
  v.setUint16(2, data.length, true)
  out.set(data, 4)
  return out
}

/** A ZIP64 extra field holding these 64-bit values, in order (original size, compressed size, header offset). */
export function zip64Field(...values: number[]): Uint8Array {
  const data = new Uint8Array(values.length * 8)
  const v = new DataView(data.buffer)
  values.forEach((value, i) => v.setBigUint64(i * 8, BigInt(value), true))
  return extraField(0x0001, data)
}

/** A data descriptor (with its optional signature) for an entry: CRC and both sizes after the data. */
export function dataDescriptor(e: RawEntry, signature = true, wide = false): Uint8Array {
  const out = new Uint8Array((signature ? 4 : 0) + 4 + (wide ? 16 : 8))
  const v = new DataView(out.buffer)
  let o = 0
  if (signature) v.setUint32((o += 4) - 4, 0x08074b50, true)
  v.setUint32(o, e.crc, true)
  if (wide) {
    v.setBigUint64(o + 4, BigInt(e.compressedSize ?? e.data.length), true)
    v.setBigUint64(o + 12, BigInt(e.size), true)
  } else {
    v.setUint32(o + 4, e.compressedSize ?? e.data.length, true)
    v.setUint32(o + 8, e.size, true)
  }
  return out
}

/** The same entry as a streaming writer stores it: flag 3 set, zeros in the header, a descriptor after the data. */
export function streamed(e: RawEntry, signature = true): RawEntry {
  return { ...e, flags: (e.flags ?? 0) | 0x0008, local: { crc: 0, compressedSize: 0, size: 0 }, trailer: dataDescriptor(e, signature) }
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  return joinBytes(parts)
}

/** `concatBytes` for a list of any length (no argument spreading). */
export function joinBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** The record that ends a ZIP: `count` directory records of `directory` bytes starting at `start`. */
export function endRecord(count: number, directory: number, start: number, comment: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(22 + comment.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, 0x06054b50, true)
  v.setUint16(8, count, true)
  v.setUint16(10, count, true)
  v.setUint32(12, directory, true)
  v.setUint32(16, start, true)
  v.setUint16(20, comment.length, true)
  out.set(comment, 22)
  return out
}

/** The ZIP64 end record and its locator, for a directory of `count` records and `size` bytes at `start`; the record itself is written at `at`. */
export function zip64End(count: number, size: number, start: number, at: number): Uint8Array {
  const out = new Uint8Array(56 + 20)
  const v = new DataView(out.buffer)
  v.setUint32(0, 0x06064b50, true)
  v.setBigUint64(4, 44n, true)
  v.setUint16(12, 45, true)
  v.setUint16(14, 45, true)
  v.setBigUint64(24, BigInt(count), true)
  v.setBigUint64(32, BigInt(count), true)
  v.setBigUint64(40, BigInt(size), true)
  v.setBigUint64(48, BigInt(start), true)
  v.setUint32(56, 0x07064b50, true)
  v.setBigUint64(56 + 8, BigInt(at), true)
  v.setUint32(56 + 16, 1, true)
  return out
}

export interface RawZipOptions {
  /** The archive comment after the end record. */
  comment?: Uint8Array
  /** Write ZIP64 end records, with the ZIP64 markers in the ordinary end record. */
  zip64?: boolean
}

/**
 * A ZIP made of exactly these entries, in this order, with whatever they
 * claim. `directory` lets the list of files differ from the data that is
 * really there (by default every entry is listed where it was written).
 */
export function rawZip(entries: RawEntry[], directory?: ((offsets: number[]) => Uint8Array[]) | null, options: RawZipOptions = {}): Uint8Array {
  const parts: Uint8Array[] = []
  const offsets: number[] = []
  let o = 0
  for (const e of entries) {
    if (e.padding) {
      parts.push(e.padding)
      o += e.padding.length
    }
    const local = localRecord(e)
    offsets.push(o)
    parts.push(local)
    o += local.length
  }
  const central = directory ? directory(offsets) : entries.map((e, i) => centralRecord(e, offsets[i]))
  const size = central.reduce((n, c) => n + c.length, 0)
  if (!options.zip64) return joinBytes([...parts, ...central, endRecord(central.length, size, o, options.comment)])
  const end = endRecord(0xffff, 0xffffffff, 0xffffffff, options.comment)
  return joinBytes([...parts, ...central, zip64End(central.length, size, o, o + size), end])
}

/** The entries of a ZIP (written by fflate or another plain writer), as raw entries (so a test can rearrange or forge them). */
export function rawEntriesOf(zip: Uint8Array): RawEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let end = zip.length - 22
  while (end > 0 && !(view.getUint32(end, true) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === zip.length)) end--
  const out: RawEntry[] = []
  let o = view.getUint32(end + 16, true)
  for (let i = 0; i < view.getUint16(end + 10, true); i++) {
    const nameLength = view.getUint16(o + 28, true)
    const compressed = view.getUint32(o + 20, true)
    const local = view.getUint32(o + 42, true)
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    out.push({ name: dec.decode(zip.subarray(o + 46, o + 46 + nameLength)), data: zip.slice(start, start + compressed), method: view.getUint16(o + 10, true), size: view.getUint32(o + 24, true), crc: view.getUint32(o + 16, true), flags: view.getUint16(o + 8, true) })
    o += 46 + nameLength + view.getUint16(o + 30, true) + view.getUint16(o + 32, true)
  }
  return out
}
