import { unzip, zip, type AsyncZippable, type Unzipped } from 'fflate'
import { isDateOnly } from '../domain/dates'
import { validateRichTextDoc } from '../domain/richtext'
import { FORMAT_VERSION, PROJECT_STATUSES, type AttachmentMeta, type CanvasObject, type WorkspaceRecords } from '../domain/types'

/**
 * Full-workspace backup archive (ZIP):
 *   manifest.json        format, version, counts, file list with SHA-256
 *   records.json         every workspace record (see docs/DATA_FORMAT.md)
 *   attachments/<id>.<ext>  original attachment bytes
 *   README.txt           human-readable explanation
 */
export const BACKUP_FORMAT = 'minty-notes-backup'
const MANIFEST = 'manifest.json'
const RECORDS = 'records.json'
const README = 'README.txt'

const MAX_TOTAL_BYTES = 4 * 1024 ** 3
const MAX_ENTRIES = 200_000
const MAX_ERRORS = 25

export interface ManifestFile {
  attachmentId: string
  path: string
  size: number
  sha256: string
  mimeType: string
}

export interface Manifest {
  format: typeof BACKUP_FORMAT
  formatVersion: number
  app: { name: string; version: string }
  createdAt: string
  workspaceId: string
  /** Format 2 adds projects, categories, and tags. */
  counts: { projects?: number; categories?: number; tags?: number; notebooks: number; sections: number; pages: number; objects: number; attachments: number }
  records: { path: string; size: number; sha256: string }
  files: ManifestFile[]
}

export interface BackupSummary {
  createdAt: string
  appVersion: string
  formatVersion: number
  workspaceId: string
  counts: Required<Manifest['counts']>
  trashedPages: number
  archivedProjects: number
  trashedProjects: number
  attachmentBytes: number
}

export type ArchiveValidation =
  | { ok: true; records: WorkspaceRecords; blobs: Map<string, Blob>; summary: BackupSummary; warnings: string[] }
  | { ok: false; errors: string[] }

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

const EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
}

function attachmentPath(meta: AttachmentMeta): string {
  return `attachments/${meta.id}${EXTENSIONS[meta.mimeType] ?? '.bin'}`
}

function zipAsync(files: AsyncZippable): Promise<Uint8Array> {
  return new Promise((resolve, reject) => zip(files, (err, data) => (err ? reject(err) : resolve(data))))
}

/** Build a complete backup archive from workspace records and attachment bytes. */
export async function buildArchive(records: WorkspaceRecords, blobs: Map<string, Blob>, appVersion: string): Promise<Uint8Array> {
  const files: ManifestFile[] = []
  const entries: AsyncZippable = {}
  for (const meta of records.attachments) {
    const blob = blobs.get(meta.id)
    if (!blob) throw new Error(`Attachment bytes are missing for “${meta.fileName}” (${meta.id}).`)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const path = attachmentPath(meta)
    files.push({ attachmentId: meta.id, path, size: bytes.byteLength, sha256: await sha256Hex(bytes), mimeType: meta.mimeType })
    entries[path] = [bytes, { level: 0 }]
  }
  const recordsBytes = encoder.encode(JSON.stringify(records, null, 1))
  const manifest: Manifest = {
    format: BACKUP_FORMAT,
    formatVersion: FORMAT_VERSION,
    app: { name: 'Minty Notes', version: appVersion },
    createdAt: new Date().toISOString(),
    workspaceId: records.workspace.workspaceId,
    counts: countsOf(records),
    records: { path: RECORDS, size: recordsBytes.byteLength, sha256: await sha256Hex(recordsBytes) },
    files,
  }
  entries[MANIFEST] = [encoder.encode(JSON.stringify(manifest, null, 2)), { level: 6 }]
  entries[RECORDS] = [recordsBytes, { level: 6 }]
  entries[README] = [
    encoder.encode(
      `Minty Notes full workspace backup\nCreated: ${manifest.createdAt}\n\n` +
        `Restore it from Minty Notes → Settings → Restore. records.json holds projects, categories,\n` +
        `tags, notes, notebooks, sections, links, and page layout. attachments/ holds the original image files.\n` +
        `This is a complete working copy, not a redacted document for sharing.\n`,
    ),
    { level: 6 },
  ]
  return zipAsync(entries)
}

function countsOf(records: WorkspaceRecords): Required<Manifest['counts']> {
  return {
    projects: records.projects.length,
    categories: records.categories.length,
    tags: records.tags.length,
    notebooks: records.notebooks.length,
    sections: records.sections.length,
    pages: records.pages.length,
    objects: records.objects.length,
    attachments: records.attachments.length,
  }
}

// ------------------------------------------------------------------ parsing

function isSafePath(name: string): boolean {
  return !name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..') && !/^[a-zA-Z]:/.test(name)
}

function unzipSafely(bytes: Uint8Array, errors: string[], warnings: string[]): Promise<Unzipped | null> {
  let total = 0
  let count = 0
  let tooLarge = false
  return new Promise((resolve) => {
    try {
      unzip(
        bytes,
        {
          filter(file) {
            count++
            if (count > MAX_ENTRIES) {
              tooLarge = true
              return false
            }
            if (!isSafePath(file.name)) {
              warnings.push(`Ignored unsafe file path in archive: ${file.name}`)
              return false
            }
            const known = file.name === MANIFEST || file.name === RECORDS || file.name.startsWith('attachments/')
            if (!known) {
              if (file.name !== README && !file.name.endsWith('/')) warnings.push(`Ignored unexpected file: ${file.name}`)
              return false
            }
            total += file.originalSize
            if (total > MAX_TOTAL_BYTES) {
              tooLarge = true
              return false
            }
            return true
          },
        },
        (err, data) => {
          if (tooLarge) {
            errors.push('The archive is larger than Minty Notes can safely restore.')
            resolve(null)
          } else if (err) {
            errors.push(`The archive could not be read: ${err.message}`)
            resolve(null)
          } else resolve(data)
        },
      )
    } catch (err) {
      errors.push(`The archive could not be read: ${err instanceof Error ? err.message : String(err)}`)
      resolve(null)
    }
  })
}

function parseJson(bytes: Uint8Array | undefined, label: string, errors: string[]): unknown {
  if (!bytes) {
    errors.push(`${label} is missing.`)
    return undefined
  }
  try {
    return JSON.parse(decoder.decode(bytes))
  } catch {
    errors.push(`${label} is not valid JSON.`)
    return undefined
  }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))

class Checker {
  readonly errors: string[]
  constructor(errors: string[]) {
    this.errors = errors
  }
  fail(message: string): void {
    if (this.errors.length < MAX_ERRORS) this.errors.push(message)
    else if (this.errors.length === MAX_ERRORS) this.errors.push('…further problems omitted.')
  }
  require(cond: boolean, message: string): boolean {
    if (!cond) this.fail(message)
    return cond
  }
}

function checkCommon(c: Checker, kind: string, r: unknown, i: number): r is Obj {
  if (!c.require(isObj(r), `${kind} #${i + 1} is not an object.`)) return false
  const o = r as Obj
  return c.require(isId(o.id) && isTime(o.createdAt) && isTime(o.updatedAt), `${kind} #${i + 1} has a missing or invalid id or timestamp.`)
}

const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isId)

function validateRecords(raw: unknown, c: Checker): WorkspaceRecords | null {
  if (!c.require(isObj(raw), 'records.json does not contain a records object.')) return null
  const r = raw as Obj
  const lists = ['projects', 'categories', 'tags', 'notebooks', 'sections', 'pages', 'objects', 'attachments'] as const
  for (const key of lists) if (!c.require(Array.isArray(r[key]), `records.json is missing the ${key} list.`)) return null
  const ws = r.workspace
  if (!c.require(isObj(ws) && isId(ws.workspaceId) && isNum(ws.formatVersion) && isTime(ws.createdAt), 'Workspace information is missing or invalid.')) return null

  const ids = new Set<string>()
  const unique = (kind: string, id: string) => c.require(!ids.has(id), `Duplicate ${kind} id ${id}.`) && ids.add(id)
  const idsOf = (list: unknown[]) => new Set(list.filter(isObj).map((x) => x.id))

  const categories = r.categories as unknown[]
  categories.forEach((x, i) => {
    if (checkCommon(c, 'Category', x, i) && c.require(isStr(x.name) && isNum(x.order), `Category #${i + 1} is invalid.`)) unique('category', x.id as string)
  })
  const categoryIds = idsOf(categories)
  const checkCategories = (kind: string, name: unknown, v: unknown) => {
    if (!c.require(isIdList(v), `${kind} “${String(name)}” has an invalid category list.`)) return false
    for (const id of v as string[]) c.require(categoryIds.has(id), `${kind} “${String(name)}” refers to a missing category.`)
    return true
  }

  const tags = r.tags as unknown[]
  tags.forEach((x, i) => {
    if (checkCommon(c, 'Tag', x, i) && c.require(isStr(x.name), `Tag #${i + 1} is invalid.`)) unique('tag', x.id as string)
  })
  const tagIds = idsOf(tags)

  const notebooks = r.notebooks as unknown[]
  notebooks.forEach((n, i) => {
    if (checkCommon(c, 'Notebook', n, i) && c.require(isStr(n.title) && isNum(n.order), `Notebook #${i + 1} is invalid.`) && checkCategories('Notebook', n.title, n.categoryIds)) unique('notebook', n.id as string)
  })
  const notebookIds = idsOf(notebooks)

  const sections = r.sections as unknown[]
  sections.forEach((s, i) => {
    if (checkCommon(c, 'Section', s, i) && c.require(isStr(s.title) && isNum(s.order) && isId(s.notebookId), `Section #${i + 1} is invalid.`) && checkCategories('Section', s.title, s.categoryIds)) {
      unique('section', s.id as string)
      c.require(notebookIds.has(s.notebookId), `Section “${s.title}” refers to a missing notebook.`)
    }
  })
  const sectionIds = idsOf(sections)

  const projects = r.projects as unknown[]
  const pages = r.pages as unknown[]
  const pageIds = idsOf(pages)
  const isItemList = (v: unknown, keys: string[]) => Array.isArray(v) && v.every((x) => isObj(x) && isId(x.id) && keys.every((k) => isStr(x[k])))
  projects.forEach((p, i) => {
    if (!checkCommon(c, 'Project', p, i)) return
    const ok =
      isStr(p.name) &&
      isStr(p.customer) &&
      isStr(p.site) &&
      isStr(p.jobNumber) &&
      isStr(p.description) &&
      PROJECT_STATUSES.includes(p.status as never) &&
      (p.dueDate === null || isDateOnly(p.dueDate)) &&
      isNum(p.order) &&
      isItemList(p.contacts, ['name', 'role', 'phone', 'email']) &&
      isItemList(p.equipment, ['name', 'detail']) &&
      isItemList(p.software, ['name', 'detail']) &&
      isItemList(p.fileLocations, ['label', 'value']) &&
      (p.fileLocations as Obj[]).every((f) => f.kind === 'path' || f.kind === 'url') &&
      isIdList(p.pinnedPageIds) &&
      isIdList(p.hiddenPageIds) &&
      (p.archivedAt === null || isTime(p.archivedAt)) &&
      (p.trashedAt === null || isTime(p.trashedAt))
    if (!c.require(ok, `Project #${i + 1} is invalid.`)) return
    if (!checkCategories('Project', p.name, p.categoryIds)) return
    unique('project', p.id as string)
    for (const id of [...(p.pinnedPageIds as string[]), ...(p.hiddenPageIds as string[])]) {
      c.require(pageIds.has(id), `Project “${p.name}” links to a missing page.`)
    }
  })
  const projectIds = idsOf(projects)

  pages.forEach((p, i) => {
    if (!checkCommon(c, 'Page', p, i)) return
    const loc = p.location
    const locOk =
      isObj(loc) &&
      (loc.kind === 'inbox' || loc.kind === 'standalone' || (loc.kind === 'section' && isId(loc.sectionId)) || (loc.kind === 'project' && isId(loc.projectId)))
    const from = p.copiedFrom
    const fromOk = from === null || (isObj(from) && (from.pageId === null || isId(from.pageId)) && isStr(from.title) && isTime(from.at))
    if (!c.require(isStr(p.title) && isNum(p.order) && isNum(p.width) && p.width > 0 && locOk && fromOk && isIdList(p.tagIds) && (p.trashedAt === null || isTime(p.trashedAt)), `Page #${i + 1} is invalid.`)) return
    if (!checkCategories('Page', p.title, p.categoryIds)) return
    unique('page', p.id as string)
    if ((loc as Obj).kind === 'section') c.require(sectionIds.has((loc as Obj).sectionId), `Page “${p.title}” refers to a missing section.`)
    if ((loc as Obj).kind === 'project') c.require(projectIds.has((loc as Obj).projectId), `Page “${p.title}” refers to a missing project.`)
    for (const id of p.tagIds as string[]) c.require(tagIds.has(id), `Page “${p.title}” refers to a missing tag.`)
    if (isObj(from) && isId(from.pageId)) c.require(pageIds.has(from.pageId), `Page “${p.title}” was copied from a missing page.`)
  })

  const attachments = r.attachments as unknown[]
  attachments.forEach((a, i) => {
    if (!c.require(isObj(a) && isId(a.id) && isTime(a.createdAt), `Attachment #${i + 1} has a missing or invalid id or timestamp.`)) return
    const o = a as Obj
    if (c.require(isStr(o.fileName) && isStr(o.mimeType) && isNum(o.size) && isStr(o.sha256), `Attachment #${i + 1} is invalid.`)) unique('attachment', o.id as string)
  })
  const attachmentIds = idsOf(attachments)

  const objects = r.objects as unknown[]
  objects.forEach((o, i) => {
    if (!checkCommon(c, 'Canvas object', o, i)) return
    const geomOk = isNum(o.x) && isNum(o.y) && isNum(o.w) && isNum(o.h) && isNum(o.z) && o.x >= 0 && o.y >= 0 && o.w > 0 && o.h >= 0
    if (!c.require(isId(o.pageId) && geomOk, `Canvas object #${i + 1} has invalid placement.`)) return
    unique('object', o.id as string)
    c.require(pageIds.has(o.pageId), `Canvas object ${o.id} refers to a missing page.`)
    if (o.type === 'text') {
      const problem = validateRichTextDoc(o.doc)
      c.require(problem === null, `Text in object ${o.id} is not valid: ${problem}`)
    } else if (o.type === 'image') {
      if (c.require(isId(o.attachmentId) && isStr(o.alt), `Image object ${o.id} is invalid.`)) {
        c.require(attachmentIds.has(o.attachmentId), `Image object ${o.id} refers to a missing attachment.`)
      }
    } else {
      c.fail(`Canvas object ${o.id} has an unknown type.`)
    }
  })

  if (c.errors.length > 0) return null
  return r as unknown as WorkspaceRecords
}

/**
 * Known version-1 defect: deleting a section or notebook left its trashed pages
 * pointing at the missing section, and such backups were rejected. Those pages
 * (only trashed ones) are moved to the Inbox — where restoring from Trash would
 * have put them anyway. A live page with a missing section is still an error.
 */
function repairVersion1(raw: unknown, warnings: string[]): void {
  if (!isObj(raw) || !Array.isArray(raw.pages) || !Array.isArray(raw.sections)) return
  const sectionIds = new Set(raw.sections.filter(isObj).map((s) => s.id))
  let repaired = 0
  raw.pages = raw.pages.map((p: unknown) => {
    if (isObj(p) && isTime(p.trashedAt) && isObj(p.location) && p.location.kind === 'section' && !sectionIds.has(p.location.sectionId)) {
      repaired++
      return { ...p, location: { kind: 'inbox' } }
    }
    return p
  })
  if (repaired > 0) {
    warnings.push(`${repaired} page${repaired === 1 ? '' : 's'} in the Trash belonged to a deleted section and will be kept in the Trash with the Inbox as ${repaired === 1 ? 'its' : 'their'} location.`)
  }
}

/**
 * Format 1 → 2 (Stage 2): add the empty projects/categories/tags lists and the
 * new page/notebook/section fields. Nothing else changes: IDs, text, layout,
 * attachments, and locations are kept as they were.
 */
export function migrateRecordsV1toV2(raw: unknown): void {
  if (!isObj(raw)) return
  for (const key of ['projects', 'categories', 'tags'] as const) if (raw[key] === undefined) raw[key] = []
  const withCategories = (list: unknown) => (Array.isArray(list) ? list.map((x) => (isObj(x) && x.categoryIds === undefined ? { ...x, categoryIds: [] } : x)) : list)
  raw.notebooks = withCategories(raw.notebooks)
  raw.sections = withCategories(raw.sections)
  if (Array.isArray(raw.pages)) {
    raw.pages = raw.pages.map((p: unknown) =>
      isObj(p) ? { ...p, categoryIds: p.categoryIds ?? [], tagIds: p.tagIds ?? [], copiedFrom: p.copiedFrom === undefined ? null : p.copiedFrom } : p,
    )
  }
  if (isObj(raw.workspace) && raw.workspace.formatVersion === 1) raw.workspace = { ...raw.workspace, formatVersion: 2 }
}

/**
 * Fully validate an archive before anything is replaced: structure, version,
 * checksums, record shapes, rich text, and every relationship.
 */
export async function readArchive(bytes: Uint8Array): Promise<ArchiveValidation> {
  const errors: string[] = []
  const warnings: string[] = []
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    return { ok: false, errors: ['This file is not a Minty Notes backup (it is not a ZIP archive).'] }
  }
  const files = await unzipSafely(bytes, errors, warnings)
  if (!files) return { ok: false, errors }

  const manifest = parseJson(files[MANIFEST], 'manifest.json', errors)
  if (!isObj(manifest)) return { ok: false, errors: errors.length ? errors : ['manifest.json is invalid.'] }
  if (manifest.format !== BACKUP_FORMAT) return { ok: false, errors: ['This ZIP file is not a Minty Notes backup.'] }
  if (!isNum(manifest.formatVersion) || manifest.formatVersion < 1) return { ok: false, errors: ['The backup format version is invalid.'] }
  if (manifest.formatVersion > FORMAT_VERSION) {
    return { ok: false, errors: [`This backup was made by a newer version of Minty Notes (format ${manifest.formatVersion}). Update the app before restoring it.`] }
  }
  const m = manifest as unknown as Manifest
  if (!isObj(m.records) || !Array.isArray(m.files) || !isObj(m.counts)) return { ok: false, errors: ['manifest.json is incomplete.'] }

  const recordBytes = files[RECORDS]
  if (!recordBytes) return { ok: false, errors: ['records.json is missing from the backup.'] }
  if ((await sha256Hex(recordBytes)) !== m.records.sha256) {
    return { ok: false, errors: ['records.json does not match its checksum. The backup is damaged.'] }
  }
  const raw = parseJson(recordBytes, 'records.json', errors)
  if (errors.length) return { ok: false, errors }

  if (m.formatVersion === 1) {
    repairVersion1(raw, warnings)
    migrateRecordsV1toV2(raw)
  }
  const checker = new Checker(errors)
  const records = validateRecords(raw, checker)
  if (!records) return { ok: false, errors }

  // Attachment bytes: present, sized, and matching their checksums.
  const blobs = new Map<string, Blob>()
  const byId = new Map(m.files.filter(isObj).map((f) => [f.attachmentId, f]))
  let attachmentBytes = 0
  for (const meta of records.attachments) {
    const entry = byId.get(meta.id)
    if (!entry || !isStr(entry.path)) {
      checker.fail(`The backup has no file for attachment “${meta.fileName}”.`)
      continue
    }
    const data = files[entry.path]
    if (!data) {
      checker.fail(`The file for attachment “${meta.fileName}” is missing from the archive.`)
      continue
    }
    if (data.byteLength !== entry.size || (await sha256Hex(data)) !== entry.sha256) {
      checker.fail(`The file for attachment “${meta.fileName}” is damaged (checksum mismatch).`)
      continue
    }
    attachmentBytes += data.byteLength
    blobs.set(meta.id, new Blob([data as Uint8Array<ArrayBuffer>], { type: meta.mimeType }))
  }
  if (errors.length) return { ok: false, errors }

  const referenced = new Set(records.objects.filter((o): o is Extract<CanvasObject, { type: 'image' }> => o.type === 'image').map((o) => o.attachmentId))
  const unused = records.attachments.filter((a) => !referenced.has(a.id)).length
  if (unused > 0) warnings.push(`${unused} stored image${unused === 1 ? ' is' : 's are'} not placed on any page (kept for completeness).`)

  return {
    ok: true,
    records,
    blobs,
    warnings,
    summary: {
      createdAt: isTime(m.createdAt) ? m.createdAt : '',
      appVersion: isObj(m.app) && isStr(m.app.version) ? m.app.version : 'unknown',
      formatVersion: m.formatVersion,
      workspaceId: records.workspace.workspaceId,
      counts: countsOf(records),
      trashedPages: records.pages.filter((p) => p.trashedAt).length,
      archivedProjects: records.projects.filter((p) => p.archivedAt && !p.trashedAt).length,
      trashedProjects: records.projects.filter((p) => p.trashedAt).length,
      attachmentBytes,
    },
  }
}
