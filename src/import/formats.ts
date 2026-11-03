import { unzip } from 'fflate'

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
 * Look inside a DOCX container without unpacking it: it must be a readable
 * ZIP with `word/document.xml`, a sane number of entries, and a total
 * unpacked size within the limit (declared sizes; the converter also stops
 * at damaged entries).
 */
export function checkDocxContainer(name: string, bytes: Uint8Array): Promise<{ ok: true; macros: boolean } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    let entries = 0
    let total = 0
    let hasDocument = false
    let macros = false
    try {
      unzip(
        bytes,
        {
          filter(file) {
            entries++
            total += file.originalSize
            if (file.name === 'word/document.xml') hasDocument = true
            if (/vbaProject\.bin$/i.test(file.name)) macros = true
            return false // only the directory is read here
          },
        },
        (err) => {
          if (err) resolve({ ok: false, reason: `“${name}” is not a readable .docx file (${err.message}).` })
          else if (entries > MAX_DOCX_ENTRIES) resolve({ ok: false, reason: `“${name}” contains ${entries} parts, more than Minty Notes will open (${MAX_DOCX_ENTRIES}).` })
          else if (total > MAX_DOCX_UNPACKED) resolve({ ok: false, reason: `“${name}” would unpack to ${(total / 1024 / 1024).toFixed(0)} MB, more than the ${MAX_DOCX_UNPACKED / 1024 / 1024} MB limit.` })
          else if (!hasDocument) resolve({ ok: false, reason: `“${name}” is a ZIP file but not a Word document (no word/document.xml).` })
          else resolve({ ok: true, macros })
        },
      )
    } catch (err) {
      resolve({ ok: false, reason: `“${name}” is not a readable .docx file (${err instanceof Error ? err.message : String(err)}).` })
    }
  })
}

/** A readable page title from a file name ("Pump-spec_v2.docx" → "Pump spec v2"). */
export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim()
  return (base || 'Imported document').slice(0, 200)
}
