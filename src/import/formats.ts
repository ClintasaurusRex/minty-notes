import { checkEntry, readZipDirectory, ZipEntryError } from '../backup/zipReader'

/**
 * Local document import: format detection and safety limits (pure, no DOM).
 * Imported files are treated as untrusted. Nothing here runs content from a
 * file; it only looks at bytes.
 */

export type ImportFormat = 'docx' | 'pdf'

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const PDF_MIME = 'application/pdf'
export const IMPORT_ACCEPT = `.docx,.pdf,${DOCX_MIME},${PDF_MIME}`

/** Largest file accepted for import. */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024
/** Largest total unpacked size of a DOCX (guards against ZIP bombs). */
export const MAX_DOCX_UNPACKED = 300 * 1024 * 1024
export const MAX_DOCX_ENTRIES = 5000
/** Pages whose text is converted; the rest stay in the original only. */
export const MAX_PDF_PAGES = 300
/** Embedded images converted from one DOCX. */
export const MAX_DOCX_IMAGES = 200
/** Text characters converted (the original keeps everything). */
export const MAX_IMPORT_CHARS = 2_000_000

/**
 * Reason given (and stored as the first conversion note) when a real DOCX/PDF
 * cannot be converted and the user keeps only the original. The same wording
 * identifies such pages later, so no stored record needs a new field.
 */
const NOT_CONVERTED = ' could not be converted: '

export function notConvertedReason(name: string, why: string): string {
  return `“${name}”${NOT_CONVERTED}${why}.`
}

/** True for a page that keeps an original file without any editable conversion. */
export function isOriginalOnly(source: { fileName: string; notes: string[] }): boolean {
  return source.notes.length > 0 && source.notes[0].startsWith(`“${source.fileName}”${NOT_CONVERTED}`)
}

/** Why an original-only file was not converted (without the file name), e.g. "it is password-protected". */
export function originalOnlyReason(source: { fileName: string; notes: string[] }): string {
  const note = source.notes[0] ?? ''
  const prefix = `“${source.fileName}”${NOT_CONVERTED}`
  return (note.startsWith(prefix) ? note.slice(prefix.length) : note).replace(/\.$/, '') || 'it could not be converted'
}

export function mimeOf(format: ImportFormat): string {
  return format === 'docx' ? DOCX_MIME : PDF_MIME
}

export function formatLabel(format: ImportFormat): string {
  return format === 'docx' ? 'Word document' : 'PDF'
}

export type Detected = { ok: true; format: ImportFormat } | { ok: false; reason: string }

const startsWith = (bytes: Uint8Array, sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b)

/**
 * Decide the format from the bytes (the file name is only used in messages).
 * A ZIP is only accepted as DOCX after `checkDocxContainer`.
 */
export function detectFormat(name: string, bytes: Uint8Array): Detected {
  if (bytes.byteLength === 0) return { ok: false, reason: `“${name}” is empty.` }
  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    return { ok: false, reason: `“${name}” is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB; the import limit is ${MAX_IMPORT_BYTES / 1024 / 1024} MB. Nothing was imported.` }
  }
  // "%PDF-" within the first 1 KB (some generators put junk before it).
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024))
  if (head.includes('%PDF-')) return { ok: true, format: 'pdf' }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return { ok: true, format: 'docx' }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return { ok: false, reason: `“${name}” is an older Word (.doc) or other Office file. Only .docx and text-based PDF files can be imported; save it as .docx in Word first.` }
  }
  if (startsWith(bytes, [0x7b, 0x5c, 0x72, 0x74, 0x66])) return { ok: false, reason: `“${name}” is an RTF file. Only .docx and PDF files can be imported; save it as .docx first.` }
  return { ok: false, reason: `“${name}” is not a .docx or PDF file, so it was not imported.` }
}

/**
 * Check a DOCX container before anything reads it (the converter, the preview,
 * or an import of a project package that holds the file). Only the ZIP
 * structure is trusted, and only after it has been checked:
 *
 * 1. The directory, the header in front of every part, and every part's byte
 *    range must agree and lie inside the file (`readZipDirectory`, standard
 *    layout — Word, LibreOffice, Google Docs, and other writers use data
 *    descriptors, extra fields, and so on, which are fine). Nothing is
 *    unpacked for this. A part listed twice is refused.
 * 2. It must hold `word/document.xml`, at most 5,000 parts, and declare at
 *    most 300 MB in all.
 * 3. Every part must then really unpack to the size and CRC the directory
 *    records (`checkEntry`: bounded, nothing kept). Declared sizes are
 *    therefore true, so the 300 MB limit also bounds the converter, which
 *    unpacks the same parts again.
 */
export async function checkDocxContainer(name: string, bytes: Uint8Array): Promise<{ ok: true; macros: boolean } | { ok: false; reason: string }> {
  try {
    return await checkContainer(name, bytes)
  } catch (err) {
    // Never throws for a bad file: anything unexpected is a reason, like any other.
    return { ok: false, reason: `“${name}” is not a readable .docx file (${err instanceof Error ? err.message : String(err)}).` }
  }
}

async function checkContainer(name: string, bytes: Uint8Array): Promise<{ ok: true; macros: boolean } | { ok: false; reason: string }> {
  const unreadable = (detail: string) => ({ ok: false as const, reason: `“${name}” is not a readable .docx file (${detail}).` })
  const directory = readZipDirectory(bytes, MAX_DOCX_ENTRIES, 'standard')
  if (!directory.ok) {
    if (directory.reason === 'too-many') return { ok: false, reason: `“${name}” contains ${(directory.count ?? MAX_DOCX_ENTRIES + 1).toLocaleString('en-US')} parts, more than Minty Notes will open (${MAX_DOCX_ENTRIES}).` }
    return unreadable(directory.detail)
  }
  const seen = new Set<string>()
  let total = 0
  let hasDocument = false
  let macros = false
  for (const entry of directory.entries) {
    if (seen.has(entry.name)) return unreadable(`the part ${JSON.stringify(entry.name.slice(0, 120))} appears more than once`)
    seen.add(entry.name)
    total += entry.size
    if (entry.name === 'word/document.xml') hasDocument = true
    if (/vbaProject\.bin$/i.test(entry.name)) macros = true
  }
  if (total > MAX_DOCX_UNPACKED) return { ok: false, reason: `“${name}” would unpack to ${(total / 1024 / 1024).toFixed(0)} MB, more than the ${MAX_DOCX_UNPACKED / 1024 / 1024} MB limit.` }
  if (!hasDocument) return { ok: false, reason: `“${name}” is a ZIP file but not a Word document (no word/document.xml).` }
  for (const entry of directory.entries) {
    try {
      await checkEntry(bytes, entry, MAX_DOCX_UNPACKED, 'document')
    } catch (err) {
      if (err instanceof ZipEntryError) return unreadable(err.message.replace(/\.$/, ''))
      throw err
    }
  }
  return { ok: true, macros }
}

/** A readable page title from a file name ("Pump-spec_v2.docx" → "Pump spec v2"). */
export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim()
  return (base || 'Imported document').slice(0, 200)
}
