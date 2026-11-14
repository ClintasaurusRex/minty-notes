import { PROJECT_PACKAGE_FORMAT, type ManifestFile } from '../backup/archive'
import type { AttachmentMeta, CanvasObject, Category, Page, Project, Tag, Task } from '../domain/types'

/**
 * Portable project package (ZIP) — one project with what it needs, for moving
 * to another computer or coworker. It is NOT a workspace backup: importing it
 * adds one new project and never replaces anything. See docs/DATA_FORMAT.md.
 *
 *   manifest.json          format, versions, counts, checksums of every file
 *   project.json           the project's records (see PackageRecords)
 *   attachments/<n>.<ext>  original bytes of images and imported documents
 *   README.txt             human-readable explanation
 */
export { PROJECT_PACKAGE_FORMAT }

/** Version of the package layout itself. Newer packages are refused ("update the app"). */
export const PACKAGE_VERSION = 1
/** Oldest record format a package can hold (packages first existed with data format 4). */
export const PACKAGE_MIN_DATA_FORMAT = 4

export const PACKAGE_MANIFEST = 'manifest.json'
export const PACKAGE_RECORDS = 'project.json'
export const PACKAGE_README = 'README.txt'
/** `attachments/<sequence number>.<extension>` — never built from record IDs or file names. */
export const PACKAGE_ATTACHMENT_PATH = /^attachments\/\d{1,6}\.[a-z0-9]{1,5}$/

const MiB = 1024 * 1024

/** Limits for an imported package (untrusted input). Larger packages are refused before unpacking. */
export const PACKAGE_LIMITS = {
  /** The package file itself. */
  fileBytes: 1024 * MiB,
  /** Total size the ZIP directory declares after unpacking. */
  unpackedBytes: 2048 * MiB,
  /** Files in the ZIP. */
  entries: 20_000,
  manifestBytes: 8 * MiB,
  recordsBytes: 128 * MiB,
  pages: 5_000,
  objects: 100_000,
  tasks: 20_000,
  attachments: 10_000,
  /** Categories, and tags. */
  labels: 2_000,
  /** Contacts, equipment, software, or file locations of the project. */
  listItems: 2_000,
  /** Names and titles. */
  nameLength: 2_000,
  /** Descriptions, details, addresses, and other free text fields. */
  textLength: 200_000,
  pageWidth: { min: 100, max: 20_000 },
  /** Largest object coordinate or size on a page, in CSS pixels. */
  coordinate: 10_000_000,
} as const

/** Why a page outside the project is in the package. */
export type ReferenceReason = 'pinned' | 'link' | 'task' | 'suggested'

export const REFERENCE_REASON_LABELS: Record<ReferenceReason, string> = {
  pinned: 'pinned to the project',
  link: 'linked from a project note',
  task: 'linked from a task',
  suggested: 'suggested by category',
}

/** A reference snapshot: a copy of a page that the project linked to but did not own. */
export interface PackageReference {
  /** → `pages` in the package. */
  pageId: string
  reasons: ReferenceReason[]
  /** Where the page lived in the source workspace (text only, e.g. "VTScada › Alarms"). */
  from: string
}

/**
 * `project.json`. Every page (the project's notes and the reference snapshots)
 * is owned by the one project, so the package is a small self-contained
 * workspace: no ID in it points outside it, except page links in text, which
 * may point at pages that were not included.
 */
export interface PackageRecords {
  project: Project
  tasks: Task[]
  categories: Category[]
  tags: Tag[]
  pages: Page[]
  objects: CanvasObject[]
  attachments: AttachmentMeta[]
  references: PackageReference[]
}

export interface PackageCounts {
  notes: number
  references: number
  tasks: number
  objects: number
  attachments: number
  categories: number
  tags: number
}

export interface PackageManifest {
  format: typeof PROJECT_PACKAGE_FORMAT
  packageVersion: number
  /** Data format of the records (`FORMAT_VERSION` of the exporting app). */
  formatVersion: number
  app: { name: string; version: string }
  createdAt: string
  sourceWorkspaceId: string
  projectName: string
  counts: PackageCounts
  records: { path: string; size: number; sha256: string }
  files: ManifestFile[]
}

function stamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
}

/**
 * `minty-project-<name>-YYYYMMDD-HHMMSSZ.zip`. The prefix differs from backup
 * snapshots (`minty-notes-backup-…`), so a package saved in the backup folder
 * is never counted or pruned as a snapshot.
 */
export function projectPackageFileName(projectName: string, date = new Date()): string {
  const slug = projectName
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  return `minty-project-${slug || 'project'}-${stamp(date)}.zip`
}
