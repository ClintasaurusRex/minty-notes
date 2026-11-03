/**
 * Core record types for the Minty Notes workspace (data format version 4).
 *
 * Every record has a stable ID. Links between records always use IDs,
 * never titles or folder names. See docs/DATA_FORMAT.md.
 */

/** Version of the stored data and backup format. Bump with a migration. */
export const FORMAT_VERSION = 4

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
 * `url` is a web link (e.g. Dropbox) that opens in a new tab (http/https only).
 */
export interface FileLocation {
  id: string
  label: string
  kind: 'path' | 'url'
  value: string
  /** What the file or folder is for (format 3; '' when empty). */
  description: string
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
  /**
   * Editable annotations and crop (format 4; absent when the image was never
   * marked up). The attachment bytes are never changed by markup.
   */
  markup?: Markup
}

/** A freehand/vector drawing on the page (format 4), e.g. a simple wiring sketch. */
export interface SketchObject extends CanvasObjectBase {
  type: 'sketch'
  /** Drawing coordinate space and items (`crop` is always null). */
  markup: Markup
}

export type CanvasObject = TextObject | ImageObject | SketchObject

/** A rectangle in markup coordinates. */
export interface MarkupRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * One annotation. Coordinates and sizes are in the markup's own space (an
 * image's natural pixels, or a sketch's drawing size), so they scale with the
 * object. `blur` is visual only; `redact` is an opaque cover. Neither removes
 * pixels from the stored original; only a flattened export replaces them.
 */
export type Annotation =
  | { id: string; kind: 'arrow' | 'line'; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | { id: string; kind: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number; color: string; width: number; fill: string | null }
  | { id: string; kind: 'text'; x: number; y: number; text: string; color: string; size: number; background: string | null }
  | { id: string; kind: 'pen' | 'highlighter'; points: number[]; color: string; width: number }
  | { id: string; kind: 'blur' | 'redact'; x: number; y: number; w: number; h: number }

export type AnnotationKind = Annotation['kind']

/** Annotations on an image or in a sketch (format 4). */
export interface Markup {
  /** Size of the coordinate space: the image's natural pixel size, or the sketch's drawing size. */
  width: number
  height: number
  /** Visible part of the image (null = all of it; always null for sketches). Non-destructive. */
  crop: MarkupRect | null
  /** Drawn in order (later on top); blur and redact areas are drawn under the others. */
  items: Annotation[]
}

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

export type TaskStatus = 'todo' | 'doing' | 'done'
export const TASK_STATUSES: TaskStatus[] = ['todo', 'doing', 'done']

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent'
/** Lowest to highest. */
export const TASK_PRIORITIES: TaskPriority[] = ['low', 'normal', 'high', 'urgent']

/** A task on a project's board (format 3). */
export interface Task {
  id: string
  /** Owning project. Tasks always belong to one project. */
  projectId: string
  title: string
  /** Plain-text details. */
  description: string
  status: TaskStatus
  priority: TaskPriority
  /** Optional date-only deadline (`YYYY-MM-DD`, four-digit year). */
  dueDate: DateOnly | null
  /** Notes this task refers to (any page, by ID; the pages are not copied). */
  linkedPageIds: string[]
  /** Position within its status column (ascending). */
  order: number
  /** Set while the task is Done. */
  completedAt: Timestamp | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

/** A canvas object stored inside a template (no IDs: new ones are made on use). */
export type TemplateObject =
  | { type: 'text'; x: number; y: number; w: number; h: number; z: number; doc: RichTextDoc }
  | { type: 'image'; x: number; y: number; w: number; h: number; z: number; attachmentId: string; alt: string; markup?: Markup }
  | { type: 'sketch'; x: number; y: number; w: number; h: number; z: number; markup: Markup }

/** One note inside a template. */
export interface TemplateNote {
  title: string
  categoryIds: string[]
  tagIds: string[]
  objects: TemplateObject[]
}

/** One task inside a project template. */
export interface TemplateTask {
  title: string
  description: string
  priority: TaskPriority
  /** Links to notes of this template (indexes into `notes`). */
  noteIndexes: number[]
  /** Links to library pages (shared, by ID; never copied). */
  pageIds: string[]
}

/** Reusable project settings (instance details such as name, customer, job number, and dates are not kept). */
export interface TemplateProject {
  status: ProjectStatus
  description: string
  categoryIds: string[]
  /** Library pages to link (shared references, not copies). */
  pinnedPageIds: string[]
  equipment: ProjectItem[]
  software: ProjectItem[]
  fileLocations: FileLocation[]
}

/**
 * A reusable definition (format 3). A note template holds one note; a project
 * template holds project settings, its notes, and its tasks. Using a template
 * always creates new, independent records with new IDs.
 */
export interface Template {
  id: string
  kind: 'note' | 'project'
  name: string
  description: string
  notes: TemplateNote[]
  /** Set for project templates only. */
  project: TemplateProject | null
  tasks: TemplateTask[]
  createdAt: Timestamp
  updatedAt: Timestamp
}

/** Everything that makes up a workspace (used by backup and restore). */
export interface WorkspaceRecords {
  workspace: WorkspaceInfo
  projects: Project[]
  tasks: Task[]
  templates: Template[]
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
