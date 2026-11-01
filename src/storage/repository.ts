import {
  FORMAT_VERSION,
  newId,
  nowIso,
  type AttachmentMeta,
  type CanvasObject,
  type Notebook,
  type Page,
  type Section,
  type WorkspaceInfo,
  type WorkspaceRecords,
} from '../domain/types'
import { ALL_STORES, openMintyDB, type MintyDatabase, type OpenOptions, type RecordStoreName } from './db'

/** Pending record writes. A `null` value deletes the record. */
export type ChangeSet = {
  notebooks: Map<string, Notebook | null>
  sections: Map<string, Section | null>
  pages: Map<string, Page | null>
  objects: Map<string, CanvasObject | null>
}

export function emptyChangeSet(): ChangeSet {
  return { notebooks: new Map(), sections: new Map(), pages: new Map(), objects: new Map() }
}

export function changeSetSize(c: ChangeSet): number {
  return c.notebooks.size + c.sections.size + c.pages.size + c.objects.size
}

/** Settings keys. Only `workspace` is part of a backup; the rest are device-local. */
export const SETTINGS = {
  workspace: 'workspace',
  activity: 'activity',
  backupFolder: 'backupFolder',
  backupStatus: 'backupStatus',
  ui: 'ui',
  safeguard: 'safeguard',
} as const

export interface Activity {
  lastChangeAt: string | null
}

export interface WorkspaceIndex {
  workspace: WorkspaceInfo
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
  /** Atomically write a set of record changes and update the activity timestamp. */
  commit(changes: ChangeSet, at: string): Promise<void>
  putAttachment(meta: AttachmentMeta, blob: Blob): Promise<void>
  getBlob(id: string): Promise<Blob | undefined>
  getSetting<T>(key: string): Promise<T | undefined>
  setSetting(key: string, value: unknown): Promise<void>
  deleteSetting(key: string): Promise<void>
  readAll(): Promise<{ records: WorkspaceRecords; blobs: Map<string, Blob> }>
  /** Replace every workspace record in one transaction. Device settings are kept. */
  replaceAll(records: WorkspaceRecords, blobs: Map<string, Blob>): Promise<void>
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
    const tx = this.db.transaction(['notebooks', 'sections', 'pages', 'attachments', 'settings'], 'readwrite')
    let workspace = (await tx.objectStore('settings').get(SETTINGS.workspace)) as WorkspaceInfo | undefined
    if (!workspace) {
      workspace = { workspaceId: newId(), formatVersion: FORMAT_VERSION, createdAt: nowIso() }
      await tx.objectStore('settings').put(workspace, SETTINGS.workspace)
    }
    const [notebooks, sections, pages, attachments, activity] = await Promise.all([
      tx.objectStore('notebooks').getAll(),
      tx.objectStore('sections').getAll(),
      tx.objectStore('pages').getAll(),
      tx.objectStore('attachments').getAll(),
      tx.objectStore('settings').get(SETTINGS.activity) as Promise<Activity | undefined>,
    ])
    await tx.done
    return { workspace, notebooks, sections, pages, attachments, activity: activity ?? { lastChangeAt: null } }
  }

  loadPageObjects(pageId: string): Promise<CanvasObject[]> {
    return this.db.getAllFromIndex('objects', 'byPage', pageId)
  }

  async commit(changes: ChangeSet, at: string): Promise<void> {
    const stores: (RecordStoreName | 'settings')[] = ['notebooks', 'sections', 'pages', 'objects', 'settings']
    const tx = this.db.transaction(stores, 'readwrite')
    const ops: Promise<unknown>[] = []
    const apply = <T extends { id: string }>(name: RecordStoreName, map: Map<string, T | null>) => {
      const store = tx.objectStore(name)
      for (const [id, value] of map) {
        ops.push(value ? store.put(value as never) : store.delete(id))
      }
    }
    apply('notebooks', changes.notebooks)
    apply('sections', changes.sections)
    apply('pages', changes.pages)
    apply('objects', changes.objects)
    ops.push(tx.objectStore('settings').put({ lastChangeAt: at } satisfies Activity, SETTINGS.activity))
    await Promise.all([...ops, tx.done])
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

  async readAll(): Promise<{ records: WorkspaceRecords; blobs: Map<string, Blob> }> {
    const tx = this.db.transaction(ALL_STORES, 'readonly')
    const [workspace, notebooks, sections, pages, objects, attachments] = await Promise.all([
      tx.objectStore('settings').get(SETTINGS.workspace) as Promise<WorkspaceInfo | undefined>,
      tx.objectStore('notebooks').getAll(),
      tx.objectStore('sections').getAll(),
      tx.objectStore('pages').getAll(),
      tx.objectStore('objects').getAll(),
      tx.objectStore('attachments').getAll(),
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
    return { records: { workspace, notebooks, sections, pages, objects, attachments }, blobs }
  }

  async replaceAll(records: WorkspaceRecords, blobs: Map<string, Blob>): Promise<void> {
    const missing = records.attachments.find((a) => !blobs.has(a.id))
    if (missing) throw new Error(`Missing bytes for attachment ${missing.id}`)
    const tx = this.db.transaction(ALL_STORES, 'readwrite')
    const ops: Promise<unknown>[] = []
    for (const name of ['notebooks', 'sections', 'pages', 'objects', 'attachments', 'blobs'] as const) {
      ops.push(tx.objectStore(name).clear())
    }
    for (const n of records.notebooks) ops.push(tx.objectStore('notebooks').put(n))
    for (const s of records.sections) ops.push(tx.objectStore('sections').put(s))
    for (const p of records.pages) ops.push(tx.objectStore('pages').put(p))
    for (const o of records.objects) ops.push(tx.objectStore('objects').put(o))
    for (const a of records.attachments) {
      ops.push(tx.objectStore('attachments').put(a))
      ops.push(tx.objectStore('blobs').put(blobs.get(a.id)!, a.id))
    }
    const settings = tx.objectStore('settings')
    ops.push(settings.put(records.workspace, SETTINGS.workspace))
    // A restore is a change: the next folder snapshot should capture it.
    ops.push(settings.put({ lastChangeAt: nowIso() } satisfies Activity, SETTINGS.activity))
    ops.push(settings.delete(SETTINGS.ui))
    await Promise.all([...ops, tx.done])
  }

  close(): void {
    this.db.close()
  }
}

/** Human-readable description of a storage failure. Never implies success. */
export function describeStorageError(err: unknown): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : ''
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
