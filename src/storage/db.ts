import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb'
import { FORMAT_VERSION, type AttachmentMeta, type CanvasObject, type Category, type Notebook, type Page, type Project, type Section, type Tag } from '../domain/types'

export const DB_NAME = 'minty-notes'
/**
 * IndexedDB schema version. Independent of the backup FORMAT_VERSION.
 * 1: initial stores.
 * 2: `activity.revision` counter; trashed pages left pointing at a deleted
 *    section are moved to the Inbox (see migrateToV2).
 * 3: `projects`, `categories`, `tags` stores; pages gain categoryIds/tagIds/copiedFrom,
 *    notebooks and sections gain categoryIds (see migrateToV3).
 */
export const DB_VERSION = 3

export interface MintyDB extends DBSchema {
  projects: { key: string; value: Project }
  categories: { key: string; value: Category }
  tags: { key: string; value: Tag }
  notebooks: { key: string; value: Notebook }
  sections: { key: string; value: Section; indexes: { byNotebook: string } }
  pages: { key: string; value: Page }
  objects: { key: string; value: CanvasObject; indexes: { byPage: string } }
  /** Attachment metadata. Bytes live separately in `blobs` under the same ID. */
  attachments: { key: string; value: AttachmentMeta }
  blobs: { key: string; value: Blob }
  /** Device-local settings and workspace info (out-of-line keys). */
  settings: { key: string; value: unknown }
}

export type RecordStoreName = 'projects' | 'categories' | 'tags' | 'notebooks' | 'sections' | 'pages' | 'objects'
export const RECORD_STORES: RecordStoreName[] = ['projects', 'categories', 'tags', 'notebooks', 'sections', 'pages', 'objects']
export const ALL_STORES = ['projects', 'categories', 'tags', 'notebooks', 'sections', 'pages', 'objects', 'attachments', 'blobs', 'settings'] as const

export type MintyDatabase = IDBPDatabase<MintyDB>

export interface OpenOptions {
  /** Called when another tab needs to upgrade the database. */
  onBlocking?: () => void
}

/** Version-1 object stores (unchanged in version 2). */
export function createV1Stores(db: IDBPDatabase<MintyDB>): void {
  db.createObjectStore('notebooks', { keyPath: 'id' })
  const sections = db.createObjectStore('sections', { keyPath: 'id' })
  sections.createIndex('byNotebook', 'notebookId')
  db.createObjectStore('pages', { keyPath: 'id' })
  const objects = db.createObjectStore('objects', { keyPath: 'id' })
  objects.createIndex('byPage', 'pageId')
  db.createObjectStore('attachments', { keyPath: 'id' })
  db.createObjectStore('blobs')
  db.createObjectStore('settings')
}

/** Version-3 object stores (projects and reusable-knowledge labels). */
export function createV3Stores(db: IDBPDatabase<MintyDB>): void {
  db.createObjectStore('projects', { keyPath: 'id' })
  db.createObjectStore('categories', { keyPath: 'id' })
  db.createObjectStore('tags', { keyPath: 'id' })
}

type UpgradeTx = IDBPTransaction<MintyDB, StoreNames<MintyDB>[], 'versionchange'>

/**
 * Version 1 → 2, inside the upgrade transaction (all or nothing):
 * - add a numeric `revision` to the activity record (1 if anything was ever saved);
 * - repair pages whose section no longer exists (possible in version 1 when a
 *   section or notebook was deleted while one of its pages was in the Trash).
 */
export async function migrateToV2(tx: UpgradeTx): Promise<void> {
  const settings = tx.objectStore('settings')
  const activity = (await settings.get('activity')) as { lastChangeAt?: string | null; revision?: unknown } | undefined
  if (activity && typeof activity.revision !== 'number') {
    await settings.put({ lastChangeAt: activity.lastChangeAt ?? null, revision: activity.lastChangeAt ? 1 : 0 }, 'activity')
  }
  const sectionIds = new Set<string>(await tx.objectStore('sections').getAllKeys())
  const pages = tx.objectStore('pages')
  for (const page of await pages.getAll()) {
    if (page.location.kind === 'section' && !sectionIds.has(page.location.sectionId)) {
      await pages.put({ ...page, location: { kind: 'inbox' } })
    }
  }
}

/**
 * Version 2 → 3, inside the upgrade transaction: give every existing page,
 * notebook, and section the new (empty) label fields, and mark the workspace
 * as data format 2. IDs, content, attachments, and layout are untouched.
 */
export async function migrateToV3(tx: UpgradeTx): Promise<void> {
  const pages = tx.objectStore('pages')
  for (const page of await pages.getAll()) {
    const p = page as Partial<Page> & Page
    await pages.put({ ...p, categoryIds: Array.isArray(p.categoryIds) ? p.categoryIds : [], tagIds: Array.isArray(p.tagIds) ? p.tagIds : [], copiedFrom: p.copiedFrom ?? null })
  }
  for (const name of ['notebooks', 'sections'] as const) {
    const store = tx.objectStore(name)
    for (const rec of await store.getAll()) {
      if (!Array.isArray((rec as Partial<Notebook>).categoryIds)) await store.put({ ...rec, categoryIds: [] } as never)
    }
  }
  const settings = tx.objectStore('settings')
  const workspace = (await settings.get('workspace')) as { formatVersion?: number } | undefined
  if (workspace && (workspace.formatVersion ?? 1) < FORMAT_VERSION) await settings.put({ ...workspace, formatVersion: FORMAT_VERSION }, 'workspace')
}

export function openMintyDB(name = DB_NAME, options: OpenOptions = {}): Promise<MintyDatabase> {
  return openDB<MintyDB>(name, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      if (oldVersion < 1) createV1Stores(db)
      if (oldVersion < 3) createV3Stores(db)
      if (oldVersion >= 1) {
        // Data migrations run in order inside the one upgrade transaction. Any
        // failure aborts the whole upgrade, so the older data stays untouched.
        void (async () => {
          if (oldVersion < 2) await migrateToV2(transaction)
          if (oldVersion < 3) await migrateToV3(transaction)
        })().catch(() => transaction.abort())
        // The open request reports the failure; don't also leave an unhandled rejection.
        transaction.done.catch(() => undefined)
      }
    },
    blocking() {
      options.onBlocking?.()
    },
  })
}
