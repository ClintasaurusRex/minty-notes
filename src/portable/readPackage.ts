import { BACKUP_FORMAT, Checker, isSafePath, migrateRecordsV4toV5, sha256Hex, validateRecords } from '../backup/archive'
import { pageLinkIds } from '../domain/pageLink'
import { FORMAT_VERSION, type CanvasObject } from '../domain/types'
import { DOCX_MIME, PDF_MIME } from '../import/formats'
import { imageProblem, isPackageImageType, originalProblem } from './attachmentCheck'
import { cleanPackageRecords, isSafeHref } from './cleanRecords'
import {
  PACKAGE_ATTACHMENT_PATH,
  PACKAGE_LIMITS,
  PACKAGE_MANIFEST,
  PACKAGE_MIN_DATA_FORMAT,
  PACKAGE_README,
  PACKAGE_RECORDS,
  PACKAGE_VERSION,
  PROJECT_PACKAGE_FORMAT,
  REFERENCE_REASON_LABELS,
  type PackageRecords,
  type ReferenceReason,
} from './format'
import { entryBytes, readZipDirectory, type ZipDirectory, type ZipEntry } from '../backup/zipReader'

/**
 * Reads and fully validates a portable project package before anything is
 * imported. The file is untrusted: its ZIP structure, sizes, checksums, record
 * shapes, relationships, rich text, markup, and attachment bytes are all
 * checked here, and nothing in this module touches the workspace.
 */

export interface PackageSummary {
  projectName: string
  createdAt: string
  appVersion: string
  packageVersion: number
  formatVersion: number
  sourceWorkspaceId: string
  /** Titles of the project's own notes. */
  notes: string[]
  /** Reference snapshots: copies of pages the project linked to. */
  references: { pageId: string; title: string; from: string; reasons: ReferenceReason[] }[]
  tasks: { total: number; done: number }
  objects: number
  images: number
  originals: number
  sketches: number
  attachmentBytes: number
  /** Image files shown with a redaction, blur, or crop on their page (the package holds the full original). */
  coveredImages: number
  categories: string[]
  tags: string[]
  fileLocations: { paths: number; links: number }
  /** Distinct pages that included text links to but that are not in the package. */
  unresolvedLinks: number
  /** Notes that contain such links. */
  notesWithUnresolvedLinks: number
}

export interface ValidPackage {
  ok: true
  /** Validated records, rebuilt from known fields only. IDs are still the package's own. */
  records: PackageRecords
  /** Attachment bytes by the package's attachment ID. */
  blobs: Map<string, Blob>
  summary: PackageSummary
  warnings: string[]
}

export type PackageValidation = ValidPackage | { ok: false; errors: string[] }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200
const isSha = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const isSize = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
const decoder = new TextDecoder('utf-8', { fatal: true })
const MB = (n: number) => `${Math.round(n / 1024 / 1024)} MB`
const fail = (...errors: string[]): PackageValidation => ({ ok: false, errors })

const RECORDS_MISMATCH = 'project.json does not match its checksum. The package is damaged or was changed after it was exported.'
const INCOMPLETE = 'The package’s list of files is damaged or was cut off (it may be an incomplete download or copy). Ask for the project to be exported and sent again.'

/** Why a package's ZIP directory was refused, in words (the reader only gives the reason and a detail). */
function directoryProblem(d: Extract<ZipDirectory, { ok: false }>): string {
  switch (d.reason) {
    case 'not-zip':
      return 'This file is not a Minty Notes project package (it is not a ZIP archive).'
    case 'incomplete':
      return INCOMPLETE
    case 'too-many':
      return `The package contains more than ${PACKAGE_LIMITS.entries.toLocaleString('en-US')} files.`
    case 'foreign':
      return `This ZIP file was not written by Minty Notes, or it was changed afterwards (${d.detail}). Use the package exactly as it was exported.`
  }
}
const NOT_A_PACKAGE_BUT_BACKUP = 'This file is a full workspace backup, not a project package. A backup is restored from Settings → Restore, which replaces the whole workspace; it cannot be imported as one project.'

const SOURCES = ['paste', 'file', 'drop', 'import']
const REASONS = Object.keys(REFERENCE_REASON_LABELS)

/**
 * Check the names in the ZIP directory that no archive of ours may contain:
 * the same name twice, names that differ only by letter case, unsafe paths.
 * Reads the directory only.
 */
function checkEntryNames(entries: ZipEntry[]): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  const folded = new Set<string>()
  for (const { name } of entries) {
    if (problems.length >= 5) break
    const shown = JSON.stringify(name.slice(0, 120))
    const fold = name.normalize('NFKC').toLowerCase()
    if (seen.has(name)) problems.push(`The package contains the file ${shown} more than once.`)
    else if (folded.has(fold)) problems.push(`The package contains file names that differ only by letter case (${shown}).`)
    seen.add(name)
    folded.add(fold)
    if (!isSafePath(name)) problems.push(`The package contains an unsafe file path (${shown}).`)
  }
  return problems
}

/**
 * Check the directory against the layout of a project package: only the files
 * the exporter writes, attachments stored as they are, and every size within
 * its limit. Reads the directory only.
 */
function checkLayout(entries: ZipEntry[]): string[] {
  const problems: string[] = []
  let total = 0
  for (const e of entries) {
    if (problems.length >= 5) break
    const { name } = e
    const shown = JSON.stringify(name.slice(0, 120))
    const isAttachment = PACKAGE_ATTACHMENT_PATH.test(name)
    if (name === 'attachments/' && e.size === 0 && e.method === 0) continue
    if (name !== PACKAGE_MANIFEST && name !== PACKAGE_RECORDS && name !== PACKAGE_README && !isAttachment) {
      problems.push(`The package contains a file Minty Notes did not put there (${shown}). Use the package exactly as it was exported.`)
      continue
    }
    // Attachments are stored as they are (never compressed), so they cannot expand when unpacked.
    if (isAttachment && e.method !== 0) problems.push(`The package was repacked: ${shown} is compressed. Use the package exactly as it was exported.`)
    if (name === PACKAGE_MANIFEST && Math.max(e.size, e.compressedSize) > PACKAGE_LIMITS.manifestBytes) problems.push('The package’s manifest is too large.')
    if (name === PACKAGE_RECORDS && Math.max(e.size, e.compressedSize) > PACKAGE_LIMITS.recordsBytes) {
      problems.push(`The package’s project data would unpack to ${MB(Math.max(e.size, e.compressedSize))}, more than the ${MB(PACKAGE_LIMITS.recordsBytes)} limit.`)
    }
    total += e.size
  }
  if (total > PACKAGE_LIMITS.unpackedBytes) problems.push(`The package would unpack to more than ${MB(PACKAGE_LIMITS.unpackedBytes)}, the largest size Minty Notes imports.`)
  return problems
}

/** One approved JSON entry, unpacked within its limit (see `entryBytes`) and parsed. */
async function readJsonEntry(bytes: Uint8Array, entry: ZipEntry, maxBytes: number): Promise<{ data: Uint8Array; value: unknown } | { error: string }> {
  let data: Uint8Array
  try {
    data = await entryBytes(bytes, entry, maxBytes)
  } catch (err) {
    return { error: `The package is damaged or was changed after it was exported: ${err instanceof Error ? err.message : String(err)}` }
  }
  const parsed = parseJson(data, entry.name)
  return 'error' in parsed ? parsed : { data, value: parsed.value }
}

function parseJson(bytes: Uint8Array, label: string): { value: unknown } | { error: string } {
  try {
    return { value: JSON.parse(decoder.decode(bytes)) }
  } catch {
    return { error: `${label} in the package is not valid. The package is damaged.` }
  }
}

/** Limits and rules that apply to a package on top of the general record checks. */
function checkPackageRules(r: PackageRecords, rawReferences: unknown[], c: Checker): void {
  const L = PACKAGE_LIMITS
  const short = (v: string) => v.length <= L.nameLength
  const long = (v: string) => v.length <= L.textLength
  const p = r.project
  c.require(short(p.name) && short(p.customer) && short(p.site) && short(p.jobNumber) && long(p.description), 'A project field is longer than Minty Notes accepts.')
  for (const list of [p.contacts, p.equipment, p.software, p.fileLocations] as unknown as Obj[][]) {
    c.require(list.length <= L.listItems, 'The project has more list entries than Minty Notes accepts.')
    c.require(new Set(list.map((x) => x.id)).size === list.length, 'A project list contains the same entry twice.')
    c.require(list.every((x) => Object.values(x).every((v) => !isStr(v) || long(v))), 'A project list entry is longer than Minty Notes accepts.')
  }
  c.require(p.hiddenPageIds.length === 0, 'The project lists hidden references, which a package cannot contain.')
  c.require(new Set(p.categoryIds).size === p.categoryIds.length, 'The project lists a category twice.')

  for (const x of [...r.categories, ...r.tags]) c.require(x.name.trim().length > 0 && short(x.name), 'A category or tag name is empty or too long.')

  const pageIds = new Set(r.pages.map((x) => x.id))
  const attachments = new Map(r.attachments.map((a) => [a.id, a]))
  const originals = new Set<string>()
  for (const page of r.pages) {
    const title = `Page “${page.title.slice(0, 80)}”`
    c.require(page.location.kind === 'project' && page.location.projectId === p.id, `${title} does not belong to the packaged project.`)
    c.require(page.trashedAt === null, `${title} is marked as being in the Trash.`)
    c.require(short(page.title) && (!page.copiedFrom || short(page.copiedFrom.title)), 'A page title is longer than Minty Notes accepts.')
    c.require(page.width >= L.pageWidth.min && page.width <= L.pageWidth.max, `${title} has an invalid width.`)
    c.require(new Set(page.categoryIds).size === page.categoryIds.length && new Set(page.tagIds).size === page.tagIds.length, `${title} lists a category or tag twice.`)
    if (page.importedFrom) {
      const original = attachments.get(page.importedFrom.attachmentId)
      originals.add(page.importedFrom.attachmentId)
      const expected = page.importedFrom.format === 'pdf' ? PDF_MIME : DOCX_MIME
      if (original) c.require(original.mimeType === expected, `The original file of ${title} is not the ${page.importedFrom.format.toUpperCase()} file it claims to be.`)
    }
  }

  const images = new Set<string>()
  for (const o of r.objects) {
    const ok = o.x <= L.coordinate && o.y <= L.coordinate && o.w <= L.coordinate && o.h <= L.coordinate && Math.abs(o.z) <= L.coordinate
    c.require(ok, `An object on a page is placed outside the size Minty Notes accepts.`)
    if (o.type === 'image') {
      images.add(o.attachmentId)
      c.require(long(o.alt), 'An image description is longer than Minty Notes accepts.')
      const meta = attachments.get(o.attachmentId)
      if (meta) c.require(isPackageImageType(meta.mimeType), `The file “${meta.fileName.slice(0, 80)}” is placed as a picture but is not an image file Minty Notes uses (${meta.mimeType.slice(0, 60)}).`)
    }
  }
  for (const a of r.attachments as unknown as (Obj & { id: string; fileName: string; mimeType: string })[]) {
    const name = `The file “${a.fileName.slice(0, 80)}”`
    const shapeOk = isSize(a.size) && isSha(a.sha256) && SOURCES.includes(a.source as string) && (a.width === null || (isNum(a.width) && a.width >= 0 && a.width <= 1_000_000)) && (a.height === null || (isNum(a.height) && a.height >= 0 && a.height <= 1_000_000)) && a.fileName.length <= 1000
    c.require(shapeOk, `${name} has invalid details.`)
    c.require(images.has(a.id) || originals.has(a.id), `${name} is not used by any note in the package.`)
    c.require(!(images.has(a.id) && originals.has(a.id)), `${name} is used both as a picture and as an imported document.`)
    c.require(isPackageImageType(a.mimeType) || a.mimeType === PDF_MIME || a.mimeType === DOCX_MIME, `${name} has a file type Minty Notes does not import (${a.mimeType.slice(0, 60)}).`)
  }

  for (const t of r.tasks) {
    c.require(t.projectId === p.id, `Task “${t.title.slice(0, 80)}” does not belong to the packaged project.`)
    c.require(short(t.title) && long(t.description), 'A task is longer than Minty Notes accepts.')
  }

  const refIds = new Set<string>()
  rawReferences.forEach((x, i) => {
    const ok = isObj(x) && isId(x.pageId) && isStr(x.from) && short(x.from) && Array.isArray(x.reasons) && x.reasons.length > 0 && x.reasons.length <= REASONS.length && x.reasons.every((s) => REASONS.includes(s as string))
    if (!c.require(ok, `Reference #${i + 1} in the package is invalid.`)) return
    const id = (x as Obj).pageId as string
    c.require(pageIds.has(id), `Reference #${i + 1} points at a page that is not in the package.`)
    c.require(!refIds.has(id), `Reference #${i + 1} is listed twice.`)
    refIds.add(id)
  })
  c.require(new Set(p.pinnedPageIds).size === p.pinnedPageIds.length && p.pinnedPageIds.every((id) => refIds.has(id)), 'The project pins a page that is not one of the package’s reference snapshots.')
}

/**
 * Fully validate a package. Returns the validated records, attachment bytes,
 * and a summary, or the reasons it cannot be imported. Never throws for a bad file.
 */
export async function readProjectPackage(bytes: Uint8Array): Promise<PackageValidation> {
  if (bytes.byteLength > PACKAGE_LIMITS.fileBytes) return fail(`This file is ${MB(bytes.byteLength)}; the largest project package Minty Notes imports is ${MB(PACKAGE_LIMITS.fileBytes)}.`)
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return fail('This file is not a Minty Notes project package (it is not a ZIP archive).')

  // ---- the ZIP directory, before anything is unpacked: structure, entry count, names.
  // Packages must be exactly what the exporter wrote (the `minty` layout).
  const directory = readZipDirectory(bytes, PACKAGE_LIMITS.entries, 'minty')
  if (!directory.ok) return fail(directoryProblem(directory))
  const nameProblems = checkEntryNames(directory.entries)
  if (nameProblems.length > 0) return fail(...nameProblems)
  const entries = new Map(directory.entries.map((e) => [e.name, e]))
  const layoutProblems = checkLayout(directory.entries)

  // ---- manifest: the one file read before the layout is judged, so that a
  // workspace backup can be named as such. There is exactly one (names are
  // unique), and it is unpacked within the manifest limit or not at all.
  const manifestEntry = entries.get(PACKAGE_MANIFEST)
  if (!manifestEntry) return fail(...(layoutProblems.length > 0 ? layoutProblems : ['This ZIP file is not a Minty Notes project package (it has no manifest.json).']))
  if (Math.max(manifestEntry.size, manifestEntry.compressedSize) > PACKAGE_LIMITS.manifestBytes) return fail(...layoutProblems)
  const manifestJson = await readJsonEntry(bytes, manifestEntry, PACKAGE_LIMITS.manifestBytes)
  if ('error' in manifestJson) return fail(...(layoutProblems.length > 0 ? layoutProblems : [manifestJson.error]))
  const m = manifestJson.value
  if (isObj(m) && m.format === BACKUP_FORMAT) return fail(NOT_A_PACKAGE_BUT_BACKUP)
  if (layoutProblems.length > 0) return fail(...layoutProblems)
  if (!isObj(m)) return fail('manifest.json in the package is not valid. The package is damaged.')
  if (m.format !== PROJECT_PACKAGE_FORMAT) return fail('This ZIP file is not a Minty Notes project package.')
  if (!Number.isInteger(m.packageVersion) || (m.packageVersion as number) < 1 || !Number.isInteger(m.formatVersion) || (m.formatVersion as number) < 1) return fail('The package’s version information is invalid.')
  if ((m.packageVersion as number) > PACKAGE_VERSION || (m.formatVersion as number) > FORMAT_VERSION) {
    return fail(`This package was made by a newer version of Minty Notes (package version ${String(m.packageVersion)}, data format ${String(m.formatVersion)}). Update the app before importing it.`)
  }
  if ((m.formatVersion as number) < PACKAGE_MIN_DATA_FORMAT) return fail(`The package claims data format ${String(m.formatVersion)}, which project packages never used. It cannot be imported.`)
  const rec = m.records
  if (!isObj(rec) || rec.path !== PACKAGE_RECORDS || !isSize(rec.size) || !isSha(rec.sha256) || !Array.isArray(m.files) || m.files.length > PACKAGE_LIMITS.attachments) return fail('manifest.json in the package is incomplete.')

  const errors: string[] = []
  const checker = new Checker(errors)
  const entryByAttachment = new Map<string, { path: string; size: number; sha256: string }>()
  const listedPaths = new Set<string>()
  m.files.forEach((f, i) => {
    const ok = isObj(f) && isId(f.attachmentId) && isStr(f.path) && PACKAGE_ATTACHMENT_PATH.test(f.path) && isSize(f.size) && isSha(f.sha256)
    if (!checker.require(ok, `File entry #${i + 1} in the manifest is invalid.`)) return
    const e = f as { attachmentId: string; path: string; size: number; sha256: string }
    checker.require(!entryByAttachment.has(e.attachmentId) && !listedPaths.has(e.path), `File entry #${i + 1} in the manifest repeats another entry.`)
    entryByAttachment.set(e.attachmentId, e)
    listedPaths.add(e.path)
  })
  for (const name of entries.keys()) {
    if (PACKAGE_ATTACHMENT_PATH.test(name)) checker.require(listedPaths.has(name), `The package contains a file its manifest does not list (${name}).`)
  }
  if (errors.length) return fail(...errors)

  // ---- project.json: size and checksum, then every record and relationship
  const recordsEntry = entries.get(PACKAGE_RECORDS)
  if (!recordsEntry) return fail('project.json is missing from the package.')
  // The manifest and the ZIP directory must agree on the size before anything is unpacked.
  if (recordsEntry.size !== rec.size) return fail(RECORDS_MISMATCH)
  const recordsJson = await readJsonEntry(bytes, recordsEntry, PACKAGE_LIMITS.recordsBytes)
  if ('error' in recordsJson) return fail(recordsJson.error)
  if (recordsJson.data.byteLength !== rec.size || (await sha256Hex(recordsJson.data)) !== rec.sha256) return fail(RECORDS_MISMATCH)
  const raw = recordsJson.value
  if (!isObj(raw) || !isObj(raw.project)) return fail('project.json does not contain a project.')
  const limits: [string, number][] = [
    ['tasks', PACKAGE_LIMITS.tasks],
    ['categories', PACKAGE_LIMITS.labels],
    ['tags', PACKAGE_LIMITS.labels],
    ['pages', PACKAGE_LIMITS.pages],
    ['objects', PACKAGE_LIMITS.objects],
    ['attachments', PACKAGE_LIMITS.attachments],
    ['references', PACKAGE_LIMITS.pages],
  ]
  for (const [key, max] of limits) {
    const list = raw[key]
    if (!Array.isArray(list)) return fail(`project.json is missing the ${key} list.`)
    if (list.length > max) return fail(`The package has ${list.length.toLocaleString('en-US')} ${key}, more than Minty Notes imports (${max.toLocaleString('en-US')}).`)
  }

  // The package is a small workspace with one project, so the same checks as a backup restore apply.
  const asWorkspace = {
    workspace: { workspaceId: 'package', formatVersion: m.formatVersion, createdAt: new Date(0).toISOString() },
    projects: [raw.project],
    tasks: raw.tasks,
    templates: [],
    categories: raw.categories,
    tags: raw.tags,
    notebooks: [],
    sections: [],
    pages: raw.pages,
    objects: raw.objects,
    attachments: raw.attachments,
  }
  if ((m.formatVersion as number) <= 4) migrateRecordsV4toV5(asWorkspace)
  const validated = validateRecords(asWorkspace, checker)
  if (!validated) return fail(...errors)
  const shaped: PackageRecords = { project: validated.projects[0], tasks: validated.tasks, categories: validated.categories, tags: validated.tags, pages: validated.pages, objects: validated.objects, attachments: validated.attachments, references: [] }
  checkPackageRules(shaped, raw.references as unknown[], checker)
  if (errors.length) return fail(...errors)
  shaped.references = raw.references as PackageRecords['references']

  // ---- attachment bytes: present, exactly as listed, and of the type they claim
  const originalFormat = new Map(shaped.pages.flatMap((p) => (p.importedFrom ? [[p.importedFrom.attachmentId, p.importedFrom.format] as const] : [])))
  const blobs = new Map<string, Blob>()
  let attachmentBytes = 0
  for (const meta of shaped.attachments) {
    const name = `“${meta.fileName.slice(0, 80)}”`
    const entry = entryByAttachment.get(meta.id)
    const zipEntry = entry ? entries.get(entry.path) : undefined
    if (!entry || !zipEntry) {
      checker.fail(`The file ${name} is missing from the package.`)
      continue
    }
    // Stored entries only (checked above): a view of the package's own bytes, exactly as long as the ZIP records.
    const data = await entryBytes(bytes, zipEntry, PACKAGE_LIMITS.fileBytes)
    const sha = await sha256Hex(data)
    if (data.byteLength !== entry.size || sha !== entry.sha256 || data.byteLength !== meta.size || sha !== meta.sha256) {
      checker.fail(`The file ${name} is damaged (it does not match its checksum).`)
      continue
    }
    // A matching checksum is not enough: the bytes must be the kind of file the record declares.
    const format = originalFormat.get(meta.id)
    const problem = format ? await originalProblem(format, meta.fileName, data) : imageProblem(meta.mimeType, data)
    if (problem) {
      checker.fail(`The file ${name} ${problem}.`)
      continue
    }
    attachmentBytes += data.byteLength
    blobs.set(meta.id, new Blob([data as Uint8Array<ArrayBuffer>], { type: meta.mimeType }))
  }
  checker.require(entryByAttachment.size === shaped.attachments.length, 'The package’s manifest lists files that no record uses.')
  if (errors.length) return fail(...errors)

  // ---- rebuild from known fields only; then describe what is inside
  const { records, unsafeLinks, renamedOriginals } = cleanPackageRecords(shaped)
  const warnings: string[] = []
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  if (unsafeLinks > 0) warnings.push(`${plural(unsafeLinks, 'link has', 'links have')} an address that is not a normal web or e-mail address. ${unsafeLinks === 1 ? 'It was' : 'They were'} removed; the linked words are kept.`)

  if (renamedOriginals > 0) warnings.push(`${plural(renamedOriginals, 'original document was', 'original documents were')} renamed so that the file name ends with its real type (.pdf or .docx).`)

  const pageIds = new Set(records.pages.map((p) => p.id))
  const referenceIds = new Set(records.references.map((x) => x.pageId))
  const outside = new Set<string>()
  const notesWithOutside = new Set<string>()
  for (const o of records.objects) {
    if (o.type !== 'text') continue
    for (const id of pageLinkIds(o.doc)) {
      if (pageIds.has(id)) continue
      outside.add(id)
      notesWithOutside.add(o.pageId)
    }
  }
  if (outside.size > 0) {
    warnings.push(`${plural(notesWithOutside.size, 'note links', 'notes link')} to ${plural(outside.size, 'page that was', 'pages that were')} not included in the package. Those links stay in the text and are shown as unavailable.`)
  }
  const unsafeLocations = records.project.fileLocations.filter((f) => f.kind === 'url' && !/^https?:\/\//i.test(f.value.trim())).length
  if (unsafeLocations > 0) warnings.push(`${plural(unsafeLocations, 'saved web link does', 'saved web links do')} not start with http:// or https://. ${unsafeLocations === 1 ? 'It is' : 'They are'} kept as text and will not open.`)
  if (records.project.fileLocations.some((f) => f.kind === 'url' && !isSafeHref(f.value))) warnings.push('A saved web link uses an unusual address type. Minty Notes never opens such links.')
  if (records.project.trashedAt) warnings.push('The project was in the Trash when it was exported. It is imported as a normal project.')
  else if (records.project.archivedAt) warnings.push('The project was archived when it was exported. It is imported as a current project.')

  const isCovered = (o: CanvasObject) => o.type === 'image' && !!o.markup && (!!o.markup.crop || o.markup.items.some((a) => a.kind === 'redact' || a.kind === 'blur'))
  const byId = new Map(records.pages.map((p) => [p.id, p]))
  return {
    ok: true,
    records,
    blobs,
    warnings,
    summary: {
      projectName: records.project.name || 'Untitled project',
      createdAt: isStr(m.createdAt) && !Number.isNaN(Date.parse(m.createdAt)) ? new Date(Date.parse(m.createdAt)).toISOString() : '',
      appVersion: isObj(m.app) && isStr(m.app.version) ? m.app.version.slice(0, 40) : 'unknown',
      packageVersion: m.packageVersion as number,
      formatVersion: m.formatVersion as number,
      sourceWorkspaceId: isId(m.sourceWorkspaceId) ? m.sourceWorkspaceId : '',
      notes: records.pages.filter((p) => !referenceIds.has(p.id)).map((p) => p.title || 'Untitled'),
      references: records.references.map((x) => ({ pageId: x.pageId, title: byId.get(x.pageId)?.title || 'Untitled', from: x.from, reasons: x.reasons })),
      tasks: { total: records.tasks.length, done: records.tasks.filter((t) => t.status === 'done').length },
      objects: records.objects.length,
      images: new Set(records.objects.flatMap((o) => (o.type === 'image' ? [o.attachmentId] : []))).size,
      originals: originalFormat.size,
      sketches: records.objects.filter((o) => o.type === 'sketch').length,
      attachmentBytes,
      coveredImages: new Set(records.objects.filter(isCovered).map((o) => (o as { attachmentId: string }).attachmentId)).size,
      categories: records.categories.map((x) => x.name),
      tags: records.tags.map((x) => x.name),
      fileLocations: { paths: records.project.fileLocations.filter((f) => f.kind === 'path').length, links: records.project.fileLocations.filter((f) => f.kind === 'url').length },
      unresolvedLinks: outside.size,
      notesWithUnresolvedLinks: notesWithOutside.size,
    },
  }
}
