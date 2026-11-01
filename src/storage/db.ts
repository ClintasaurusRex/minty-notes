import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb'
import type { AttachmentMeta, CanvasObject, Notebook, Page, Section } from '../domain/types'

export const DB_NAME = 'minty-notes'
/**
 * IndexedDB schema version. Independent of the backup FORMAT_VERSION.
 * 1: initial stores.
 * 2: `activity.revision` counter; trashed pages left pointing at a deleted
 *    section are moved to the Inbox (see migrateToV2).
 */
export const DB_VERSION = 2

export interface MintyDB extends DBSchema {
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

export type RecordStoreName = 'notebooks' | 'sections' | 'pages' | 'objects'
export const RECORD_STORES: RecordStoreName[] = ['notebooks', 'sections', 'pages', 'objects']
export const ALL_STORES = ['notebooks', 'sections', 'pages', 'objects', 'attachments', 'blobs', 'settings'] as const

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

export function openMintyDB(name = DB_NAME, options: OpenOptions = {}): Promise<MintyDatabase> {
  return openDB<MintyDB>(name, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      if (oldVersion < 1) createV1Stores(db)
      if (oldVersion >= 1 && oldVersion < 2) {
        // Abort the whole upgrade on failure so version-1 data stays untouched.
        migrateToV2(transaction).catch(() => transaction.abort())
      }
    },
    blocking() {
      options.onBlocking?.()
    },
  })
}
