import type { AsyncZippable } from 'fflate'
import { attachmentExtension, sha256Hex, zipAsync, type ManifestFile } from '../backup/archive'
import { FORMAT_VERSION, type AttachmentMeta } from '../domain/types'
import { sniffImageType } from './attachmentCheck'
import { PACKAGE_MANIFEST, PACKAGE_README, PACKAGE_RECORDS, PACKAGE_VERSION, PROJECT_PACKAGE_FORMAT, type PackageManifest, type PackageRecords } from './format'

const encoder = new TextEncoder()

const README_TEXT = (name: string, createdAt: string) =>
  `Minty Notes portable project package\n` +
  `Project: ${name}\nCreated: ${createdAt}\n\n` +
  `Open Minty Notes → Projects → Import project, and choose this file as it is (do not unpack it).\n` +
  `Importing adds this project as a new project. It never replaces or changes what is already in the workspace.\n\n` +
  `project.json holds the project, its notes, tasks, categories, tags, page layout, and copies of the reference\n` +
  `pages it linked to. attachments/ holds the original image files and the original files of imported documents.\n\n` +
  `PRIVACY: this is editable project data, not a sanitized document. The original image files are included in\n` +
  `full, also where a screenshot shows a redaction box, a blur, or a crop. To share a picture or a note without\n` +
  `the hidden parts, use “Save PNG copy” or “Export PDF” in Minty Notes instead.\n\n` +
  `Not included: the rest of the workspace, other projects, and the contents of saved file locations\n` +
  `(folder paths and web links are kept as text only). This file is not a workspace backup.\n`

/** “ on the note “Title”” for the first note that shows a picture (for an error message). */
function noteOf(selected: PackageRecords, attachmentId: string): string {
  const object = selected.objects.find((o) => o.type === 'image' && o.attachmentId === attachmentId)
  const page = object ? selected.pages.find((p) => p.id === object.pageId) : undefined
  return page ? ` on the note “${page.title || 'Untitled'}”` : ''
}

/**
 * Build the package ZIP from selected records and the attachment bytes of the
 * source workspace. Bytes are stored unchanged; the size and SHA-256 written
 * into the package are those of the bytes actually stored. Throws (and builds
 * nothing) if any file is missing.
 */
export async function buildProjectPackage(selected: PackageRecords, blobs: Map<string, Blob>, source: { workspaceId: string; appVersion: string; createdAt: string }): Promise<Uint8Array> {
  const files: ManifestFile[] = []
  const entries: AsyncZippable = {}
  const attachments: AttachmentMeta[] = []
  const originals = new Set(selected.pages.flatMap((p) => (p.importedFrom ? [p.importedFrom.attachmentId] : [])))
  for (const meta of selected.attachments) {
    const blob = blobs.get(meta.id)
    if (!blob) throw new Error(`The file “${meta.fileName}” is missing from this workspace, so the project cannot be exported completely.`)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const sha256 = await sha256Hex(bytes)
    // The package states what each picture really is. A browser shows, say, a JPEG that was saved as
    // “.png”, so a workspace can hold one; the bytes are packed unchanged and the type is put right.
    let mimeType = meta.mimeType
    if (!originals.has(meta.id)) {
      const actual = sniffImageType(bytes)
      if (!actual) throw new Error(`The picture “${meta.fileName}”${noteOf(selected, meta.id)} is not a PNG, JPEG, GIF, WebP, BMP, AVIF, or SVG file that Minty Notes can check, so this project cannot be exported as a package. Remove or replace that picture and export again.`)
      mimeType = actual
    }
    const path = `attachments/${String(attachments.length + 1).padStart(4, '0')}${attachmentExtension(mimeType)}`
    files.push({ attachmentId: meta.id, path, size: bytes.byteLength, sha256, mimeType })
    attachments.push({ ...meta, mimeType, size: bytes.byteLength, sha256 })
    // Stored, not recompressed: images and documents are already compressed.
    entries[path] = [bytes, { level: 0 }]
  }
  const records: PackageRecords = { ...selected, attachments }
  const recordsBytes = encoder.encode(JSON.stringify(records, null, 1))
  const manifest: PackageManifest = {
    format: PROJECT_PACKAGE_FORMAT,
    packageVersion: PACKAGE_VERSION,
    formatVersion: FORMAT_VERSION,
    app: { name: 'Minty Notes', version: source.appVersion },
    createdAt: source.createdAt,
    sourceWorkspaceId: source.workspaceId,
    projectName: records.project.name,
    counts: {
      notes: records.pages.length - records.references.length,
      references: records.references.length,
      tasks: records.tasks.length,
      objects: records.objects.length,
      attachments: records.attachments.length,
      categories: records.categories.length,
      tags: records.tags.length,
    },
    records: { path: PACKAGE_RECORDS, size: recordsBytes.byteLength, sha256: await sha256Hex(recordsBytes) },
    files,
  }
  entries[PACKAGE_MANIFEST] = [encoder.encode(JSON.stringify(manifest, null, 2)), { level: 6 }]
  entries[PACKAGE_RECORDS] = [recordsBytes, { level: 6 }]
  entries[PACKAGE_README] = [encoder.encode(README_TEXT(records.project.name, source.createdAt)), { level: 6 }]
  return zipAsync(entries)
}
