import { openDB } from 'idb'
import { describe, expect, it } from 'vitest'
import { newId, nowIso, type Notebook, type Page, type Section } from '../domain/types'
import { createV1Stores, DB_VERSION, type MintyDB } from './db'
import { emptyChangeSet, IdbRepository } from './repository'

let n = 0

/** Write a database exactly as app version 0.1.0 (schema version 1) left it. */
async function makeV1Database(withActivity: boolean) {
  const name = `minty-v1-${Date.now()}-${n++}`
  const db = await openDB<MintyDB>(name, 1, { upgrade: (d) => createV1Stores(d) })
  const at = nowIso()
  const notebook: Notebook = { id: newId(), title: 'Kept', order: 1, createdAt: at, updatedAt: at }
  const section: Section = { id: newId(), notebookId: notebook.id, title: 'General', order: 1, createdAt: at, updatedAt: at }
  const base = { order: 1, width: 1200, createdAt: at, updatedAt: at }
  const live: Page = { ...base, id: newId(), title: 'Live', location: { kind: 'section', sectionId: section.id }, trashedAt: null }
  const orphan: Page = { ...base, id: newId(), title: 'Trashed orphan', location: { kind: 'section', sectionId: 'deleted' }, trashedAt: at }
  await db.put('notebooks', notebook)
  await db.put('sections', section)
  await db.put('pages', live)
  await db.put('pages', orphan)
  await db.put('settings', { workspaceId: newId(), formatVersion: 1, createdAt: at }, 'workspace')
  if (withActivity) await db.put('settings', { lastChangeAt: at }, 'activity')
  db.close()
  return { name, live, orphan, section }
}

describe('IndexedDB migration 1 → 2', () => {
  it('adds a revision counter and moves orphaned trashed pages to the Inbox', async () => {
    expect(DB_VERSION).toBe(2)
    const v1 = await makeV1Database(true)
    const repo = await IdbRepository.open(v1.name)
    const index = await repo.loadIndex()
    const pages = Object.fromEntries(index.pages.map((p) => [p.id, p]))
    expect(pages[v1.orphan.id]).toMatchObject({ location: { kind: 'inbox' }, trashedAt: v1.orphan.trashedAt, title: 'Trashed orphan' })
    expect(pages[v1.live.id].location).toEqual({ kind: 'section', sectionId: v1.section.id })
    expect(index.activity.revision).toBe(1)
    expect(await repo.commit(emptyChangeSet(), nowIso(), null)).toBe(2)
    // The migrated data passes the app's own backup validation.
    const { records } = await repo.readAll()
    expect(records.pages).toHaveLength(2)
    repo.close()
  })

  it('starts the revision at 0 when nothing was ever saved', async () => {
    const v1 = await makeV1Database(false)
    const repo = await IdbRepository.open(v1.name)
    expect((await repo.loadIndex()).activity.revision).toBe(0)
    repo.close()
  })
})
