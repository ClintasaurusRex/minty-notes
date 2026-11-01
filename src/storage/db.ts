import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { AttachmentMeta, CanvasObject, Notebook, Page, Section } from '../domain/types'

export const DB_NAME = 'minty-notes'
/** IndexedDB schema version. Independent of the backup FORMAT_VERSION. */
export const DB_VERSION = 1

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

export function openMintyDB(name = DB_NAME, options: OpenOptions = {}): Promise<MintyDatabase> {
  return openDB<MintyDB>(name, DB_VERSION, {
    upgrade(db, oldVersion) {
      // Version 1: initial schema. Future versions add migrations below.
      if (oldVersion < 1) {
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
    },
    blocking() {
      options.onBlocking?.()
    },
  })
}
