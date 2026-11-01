/**
 * Core record types for the Minty Notes workspace (data format version 2).
 *
 * Every record has a stable ID. Links between records always use IDs,
 * never titles or folder names. See docs/DATA_FORMAT.md.
 */

/** Version of the stored data and backup format. Bump with a migration. */
export const FORMAT_VERSION = 2

/** Default notebook page width in CSS pixels (validated in Stage 0). */
export const PAGE_WIDTH = 1200

/** ISO-8601 timestamp string, e.g. 2026-11-01T19:30:00.000Z */
export type Timestamp = string

/** ProseMirror/TipTap document JSON. Validated against the editor schema. */
export interface RichTextDoc {
  type: 'doc'
  content?: RichTextNode[]
}

export interface RichTextNode {
  type: string
  attrs?: Record<string, unknown>
  content?: RichTextNode[]
  marks?: { type: string; attrs?: Record<string, unknown> }[]
  text?: string
}

export interface WorkspaceInfo {
  workspaceId: string
  formatVersion: number
  createdAt: Timestamp
}

/** Date without time or time zone: `YYYY-MM-DD`. Never converted to a timestamp. */
export type DateOnly = string

export interface Notebook {
  id: string
  title: string
  order: number
  /** System categories (e.g. VTScada). Pages in this notebook inherit them. */
  categoryIds: string[]
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface Section {
  id: string
  notebookId: string
  title: string
  order: number
  /** System categories; pages in this section inherit them. */
  categoryIds: string[]
  createdAt: Timestamp
  updatedAt: Timestamp
}

/**
 * Where a page lives (its single owner). A page never requires a project;
 * other projects can still link to it as a reference without owning it.
 */
export type PageLocation =
  | { kind: 'inbox' }
  | { kind: 'standalone' }
  | { kind: 'section'; sectionId: string }
  | { kind: 'project'; projectId: string }

/** Where an independent project copy came from. `pageId` is null once the original is deleted forever. */
export interface CopiedFrom {
  pageId: string | null
  title: string
  at: Timestamp
}

export interface Page {
  id: string
  title: string
  location: PageLocation
  order: number
  /** Page width in CSS px. Objects stay within [0, width]. */
  width: number
  /** The page's own system categories (it also inherits its section's and notebook's). */
  categoryIds: string[]
  tagIds: string[]
  /** Set on a "project copy"; the copy is independent of the original. */
  copiedFrom: CopiedFrom | null
  createdAt: Timestamp
  updatedAt: Timestamp
  /** Set when the page is in the trash; null otherwise. */
  trashedAt: Timestamp | null
}

/** A system category such as VTScada or Studio 5000. Drives reference suggestions. */
export interface Category {
  id: string
  name: string
  order: number
  createdAt: Timestamp
  updatedAt: Timestamp
}

/** A free-form label for pages (search and filtering only). */
export interface Tag {
  id: string
  name: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

export type ProjectStatus = 'planned' | 'active' | 'on-hold' | 'complete'
export const PROJECT_STATUSES: ProjectStatus[] = ['planned', 'active', 'on-hold', 'complete']

export interface Contact {
  id: string
  name: string
  role: string
  phone: string
  email: string
}

/** One piece of equipment or one software package (name + model/version/details). */
export interface ProjectItem {
  id: string
  name: string
  detail: string
}

/**
 * A saved file location. `path` is a local or network path shown for copying;
 * `url` is a web link (e.g. Dropbox) that opens in a new tab.
 */
export interface FileLocation {
  id: string
  label: string
  kind: 'path' | 'url'
  value: string
}

export interface Project {
  id: string
  name: string
  customer: string
  site: string
  jobNumber: string
  status: ProjectStatus
  dueDate: DateOnly | null
  description: string
  contacts: Contact[]
  equipment: ProjectItem[]
  software: ProjectItem[]
  fileLocations: FileLocation[]
  /** System categories; matching library pages are suggested as references. */
  categoryIds: string[]
  /** Extra reference pages linked to this project (originals, not copies). */
  pinnedPageIds: string[]
  /** Suggested references the user hid for this project (the pages are untouched). */
  hiddenPageIds: string[]
  order: number
  archivedAt: Timestamp | null
  trashedAt: Timestamp | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

interface CanvasObjectBase {
  id: string
  pageId: string
  x: number
  y: number
  w: number
  /** For text, the measured height (content-driven). For images, the set height. */
  h: number
  /** Stacking order; larger values are drawn on top. */
  z: number
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface TextObject extends CanvasObjectBase {
  type: 'text'
  doc: RichTextDoc
}

export interface ImageObject extends CanvasObjectBase {
  type: 'image'
  attachmentId: string
  alt: string
}

export type CanvasObject = TextObject | ImageObject

export interface AttachmentMeta {
  id: string
  fileName: string
  mimeType: string
  size: number
  /** Hex SHA-256 of the stored bytes. */
  sha256: string
  /** Natural pixel size for images. */
  width: number | null
  height: number | null
  source: 'paste' | 'file' | 'drop'
  createdAt: Timestamp
}

/** Everything that makes up a workspace (used by backup and restore). */
export interface WorkspaceRecords {
  workspace: WorkspaceInfo
  projects: Project[]
  categories: Category[]
  tags: Tag[]
  notebooks: Notebook[]
  sections: Section[]
  pages: Page[]
  objects: CanvasObject[]
  attachments: AttachmentMeta[]
}

export function nowIso(): Timestamp {
  return new Date().toISOString()
}

export function newId(): string {
  return crypto.randomUUID()
}
