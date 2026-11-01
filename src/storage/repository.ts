import {
  FORMAT_VERSION,
  newId,
  nowIso,
  type AttachmentMeta,
  type CanvasObject,
  type Category,
  type Notebook,
  type Page,
  type Project,
  type Section,
  type Tag,
  type WorkspaceInfo,
  type WorkspaceRecords,
} from '../domain/types'
import { ALL_STORES, openMintyDB, RECORD_STORES, type MintyDatabase, type OpenOptions, type RecordStoreName } from './db'

/** Pending record writes. A `null` value deletes the record. */
export type ChangeSet = {
  projects: Map<string, Project | null>
  categories: Map<string, Category | null>
  tags: Map<string, Tag | null>
  notebooks: Map<string, Notebook | null>
  sections: Map<string, Section | null>
  pages: Map<string, Page | null>
  objects: Map<string, CanvasObject | null>
}

export function emptyChangeSet(): ChangeSet {
  return { projects: new Map(), categories: new Map(), tags: new Map(), notebooks: new Map(), sections: new Map(), pages: new Map(), objects: new Map() }
}

export function changeSetSize(c: ChangeSet): number {
  return RECORD_STORES.reduce((n, k) => n + c[k].size, 0)
}

/** Settings keys. Only `workspace` is part of a backup; the rest are device-local. */
export const SETTINGS = {
  workspace: 'workspace',
  activity: 'activity',
  backupFolder: 'backupFolder',
  backupStatus: 'backupStatus',
  ui: 'ui',
  safeguard: 'safeguard',
  editorOwner: 'editorOwner',
} as const

export interface Activity {
  lastChangeAt: string | null
  /**
   * Increases by one with every committed change (and restore). Backups record
   * the revision they captured, so "has this been backed up?" never depends on clocks.
   */
  revision: number
}

/** The window currently allowed to write records (a fencing token). */
export interface EditorOwner {
  token: string
  at: string
}

/** A write was refused because another window has taken over editing. */
export class OwnershipError extends Error {
  constructor() {
    super('Another Minty Notes window has taken over editing, so this window can no longer save.')
    this.name = 'OwnershipError'
  }
}

export interface WorkspaceIndex {
  workspace: WorkspaceInfo
  projects: Project[]
  categories: Category[]
  tags: Tag[]
  notebooks: Notebook[]
  sections: Section[]
  pages: Page[]
  attachments: AttachmentMeta[]
  activity: Activity
}

/**
 * The persistence boundary. Everything that touches IndexedDB goes through
 * here so the UI and a future desktop shell can swap storage.
 */
export interface Repository {
  loadIndex(): Promise<WorkspaceIndex>
  loadPageObjects(pageId: string): Promise<CanvasObject[]>
  /** Every stored canvas object (used to build the local search text). */
  loadAllObjects(): Promise<CanvasObject[]>
  /**
   * Atomically write record changes and bump the revision, but only if `token`
   * still owns the workspace. Returns the new revision; throws OwnershipError otherwise.
   */
  commit(changes: ChangeSet, at: string, token: string | null): Promise<number>
  /** Make `token` the only writer; earlier owners' commits are refused from now on. */
  claimOwnership(token: string): Promise<void>
  putAttachment(meta: AttachmentMeta, blob: Blob): Promise<void>
  getBlob(id: string): Promise<Blob | undefined>
  getSetting<T>(key: string): Promise<T | undefined>
  setSetting(key: string, value: unknown): Promise<void>
  deleteSetting(key: string): Promise<void>
  /** Every record, attachment bytes, and the revision they represent (one snapshot). */
  readAll(): Promise<{ records: WorkspaceRecords; blobs: Map<string, Blob>; revision: number }>
  /** Replace every workspace record in one transaction (owner only). Device settings are kept. */
  replaceAll(records: WorkspaceRecords, blobs: Map<string, Blob>, token: string | null): Promise<number>
  close(): void
}

export class IdbRepository implements Repository {
  private readonly db: MintyDatabase
  constructor(db: MintyDatabase) {
    this.db = db
  }

  static async open(name?: string, options?: OpenOptions): Promise<IdbRepository> {
    return new IdbRepository(await openMintyDB(name, options))
  }

  async loadIndex(): Promise<WorkspaceIndex> {
    const tx = this.db.transaction(['projects', 'categories', 'tags', 'notebooks', 'sections', 'pages', 'attachments', 'settings'], 'readwrite')
    let workspace = (await tx.objectStore('settings').get(SETTINGS.workspace)) as WorkspaceInfo | undefined
    if (!workspace) {
      workspace = { workspaceId: newId(), formatVersion: FORMAT_VERSION, createdAt: nowIso() }
      await tx.objectStore('settings').put(workspace, SETTINGS.workspace)
    }
    const [projects, categories, tags, notebooks, sections, pages, attachments, activity] = await Promise.all([
      tx.objectStore('projects').getAll(),
      tx.objectStore('categories').getAll(),
      tx.objectStore('tags').getAll(),
      tx.objectStore('notebooks').getAll(),
      tx.objectStore('sections').getAll(),
      tx.objectStore('pages').getAll(),
      tx.objectStore('attachments').getAll(),
      tx.objectStore('settings').get(SETTINGS.activity) as Promise<Activity | undefined>,
    ])
    await tx.done
    return { workspace, projects, categories, tags, notebooks, sections, pages, attachments, activity: normalizeActivity(activity) }
  }

  loadPageObjects(pageId: string): Promise<CanvasObject[]> {
    return this.db.getAllFromIndex('objects', 'byPage', pageId)
  }

  loadAllObjects(): Promise<CanvasObject[]> {
    return this.db.getAll('objects')
  }

  async commit(changes: ChangeSet, at: string, token: string | null): Promise<number> {
    const stores: (RecordStoreName | 'settings')[] = [...RECORD_STORES, 'settings']
    const tx = this.db.transaction(stores, 'readwrite')
    const settings = tx.objectStore('settings')
    // Fencing check and revision read happen in the same transaction as the writes.
    const [owner, activity] = await Promise.all([
      settings.get(SETTINGS.editorOwner) as Promise<EditorOwner | undefined>,
      settings.get(SETTINGS.activity) as Promise<Partial<Activity> | undefined>,
    ])
    if (owner && owner.token !== token) {
      tx.abort()
      await tx.done.catch(() => undefined)
      throw new OwnershipError()
    }
    const ops: Promise<unknown>[] = []
    const apply = <T extends { id: string }>(name: RecordStoreName, map: Map<string, T | null>) => {
      const store = tx.objectStore(name)
      for (const [id, value] of map) {
        ops.push(value ? store.put(value as never) : store.delete(id))
      }
    }
    for (const name of RECORD_STORES) apply(name, changes[name] as Map<string, { id: string } | null>)
    const revision = normalizeActivity(activity).revision + 1
    ops.push(settings.put({ lastChangeAt: at, revision } satisfies Activity, SETTINGS.activity))
    await Promise.all([...ops, tx.done])
    return revision
  }

  async claimOwnership(token: string): Promise<void> {
    await this.db.put('settings', { token, at: nowIso() } satisfies EditorOwner, SETTINGS.editorOwner)
  }

  async putAttachment(meta: AttachmentMeta, blob: Blob): Promise<void> {
    const tx = this.db.transaction(['attachments', 'blobs'], 'readwrite')
    await Promise.all([tx.objectStore('blobs').put(blob, meta.id), tx.objectStore('attachments').put(meta), tx.done])
  }

  getBlob(id: string): Promise<Blob | undefined> {
    return this.db.get('blobs', id)
  }

  async getSetting<T>(key: string): Promise<T | undefined> {
    return (await this.db.get('settings', key)) as T | undefined
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.db.put('settings', value, key)
  }

  async deleteSetting(key: string): Promise<void> {
    await this.db.delete('settings', key)
  }

  async readAll(): Promise<{ records: WorkspaceRecords; blobs: Map<string, Blob>; revision: number }> {
    const tx = this.db.transaction(ALL_STORES, 'readonly')
    const [workspace, projects, categories, tags, notebooks, sections, pages, objects, attachments, activity] = await Promise.all([
      tx.objectStore('settings').get(SETTINGS.workspace) as Promise<WorkspaceInfo | undefined>,
      tx.objectStore('projects').getAll(),
      tx.objectStore('categories').getAll(),
      tx.objectStore('tags').getAll(),
      tx.objectStore('notebooks').getAll(),
      tx.objectStore('sections').getAll(),
      tx.objectStore('pages').getAll(),
      tx.objectStore('objects').getAll(),
      tx.objectStore('attachments').getAll(),
      tx.objectStore('settings').get(SETTINGS.activity) as Promise<Partial<Activity> | undefined>,
    ])
    const blobs = new Map<string, Blob>()
    const blobStore = tx.objectStore('blobs')
    await Promise.all(
      attachments.map(async (a) => {
        const blob = await blobStore.get(a.id)
        if (blob) blobs.set(a.id, blob)
      }),
    )
    await tx.done
    if (!workspace) throw new Error('Workspace information is missing.')
    return { records: { workspace, projects, categories, tags, notebooks, sections, pages, objects, attachments }, blobs, revision: normalizeActivity(activity).revision }
  }

  async replaceAll(records: WorkspaceRecords, blobs: Map<string, Blob>, token: string | null): Promise<number> {
    const missing = records.attachments.find((a) => !blobs.has(a.id))
    if (missing) throw new Error(`Missing bytes for attachment ${missing.id}`)
    const tx = this.db.transaction(ALL_STORES, 'readwrite')
    const settings = tx.objectStore('settings')
    const [owner, activity] = await Promise.all([
      settings.get(SETTINGS.editorOwner) as Promise<EditorOwner | undefined>,
      settings.get(SETTINGS.activity) as Promise<Partial<Activity> | undefined>,
    ])
    if (owner && owner.token !== token) {
      tx.abort()
      await tx.done.catch(() => undefined)
      throw new OwnershipError()
    }
    const ops: Promise<unknown>[] = []
    for (const name of [...RECORD_STORES, 'attachments', 'blobs'] as const) {
      ops.push(tx.objectStore(name).clear())
    }
    for (const name of RECORD_STORES) {
      const store = tx.objectStore(name)
      for (const rec of records[name]) ops.push(store.put(rec as never))
    }
    for (const a of records.attachments) {
      ops.push(tx.objectStore('attachments').put(a))
      ops.push(tx.objectStore('blobs').put(blobs.get(a.id)!, a.id))
    }
    ops.push(settings.put(records.workspace, SETTINGS.workspace))
    // A restore is a change: the next folder snapshot should capture it.
    const revision = normalizeActivity(activity).revision + 1
    ops.push(settings.put({ lastChangeAt: nowIso(), revision } satisfies Activity, SETTINGS.activity))
    ops.push(settings.delete(SETTINGS.ui))
    await Promise.all([...ops, tx.done])
    return revision
  }

  close(): void {
    this.db.close()
  }
}

function normalizeActivity(a: Partial<Activity> | undefined): Activity {
  return { lastChangeAt: a?.lastChangeAt ?? null, revision: typeof a?.revision === 'number' ? a.revision : 0 }
}

/** Human-readable description of a storage failure. Never implies success. */
export function describeStorageError(err: unknown): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : ''
  if (name === 'OwnershipError') return (err as Error).message
  if (name === 'QuotaExceededError') {
    return 'The browser has run out of storage space for Minty Notes. Free up disk space or download a backup.'
  }
  if (name === 'InvalidStateError' || name === 'TransactionInactiveError') {
    return 'The local database closed unexpectedly. Reload Minty Notes to reconnect.'
  }
  if (name === 'UnknownError') {
    return 'The browser reported a storage error. Your latest changes are kept in this window; they will be retried.'
  }
  const message = err instanceof Error ? err.message : String(err)
  return message || 'Unknown storage error.'
}
