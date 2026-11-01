/**
 * Core record types for the Minty Notes workspace (data format version 1).
 *
 * Every record has a stable ID. Links between records always use IDs,
 * never titles or folder names. See docs/DATA_FORMAT.md.
 */

/** Version of the stored data and backup format. Bump with a migration. */
export const FORMAT_VERSION = 1

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

export interface Notebook {
  id: string
  title: string
  order: number
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface Section {
  id: string
  notebookId: string
  title: string
  order: number
  createdAt: Timestamp
  updatedAt: Timestamp
}

/**
 * Where a page lives. A page never requires a project.
 * Later stages add `{ kind: 'project', projectId }`.
 */
export type PageLocation =
  | { kind: 'inbox' }
  | { kind: 'standalone' }
  | { kind: 'section'; sectionId: string }

export interface Page {
  id: string
  title: string
  location: PageLocation
  order: number
  /** Page width in CSS px. Objects stay within [0, width]. */
  width: number
  createdAt: Timestamp
  updatedAt: Timestamp
  /** Set when the page is in the trash; null otherwise. */
  trashedAt: Timestamp | null
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
