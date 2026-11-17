import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { strFromU8, unzipSync } from 'fflate'
import { dumpWorkspace, waitSaved } from './helpers'

// Synthetic release-code fixture, never a user backup/profile. The legacy
// connection models DB5 (v0.4.2): normal versionchange close, or a stale/frozen
// tab that holds the connection. The migrating tab runs the production app.
async function openLegacy(page: Page, closeOnVersionChange: boolean) {
  await page.route('**/legacy-v5', (route) => route.fulfill({ contentType: 'text/html', body: '<title>Synthetic DB5 tab</title>' }))
  await page.goto('/legacy-v5')
  const files = unzipSync(readFileSync('src/test/files/backups/minty-0.4.1-backup.zip'))
  const records = JSON.parse(strFromU8(files['records.json']))
  const manifest = JSON.parse(strFromU8(files['manifest.json']))
  const blobs = manifest.files.map((f: { attachmentId: string; path: string }) => ({ id: f.attachmentId, bytes: [...files[f.path]] }))
  await page.evaluate(async ({ records, blobs, closeOnVersionChange }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('minty-notes', 5)
      req.onupgradeneeded = () => {
        for (const name of Object.keys(records).filter((n) => n !== 'workspace')) req.result.createObjectStore(name, { keyPath: 'id' })
        req.result.createObjectStore('blobs')
        req.result.createObjectStore('settings')
        const tx = req.transaction!
        tx.objectStore('sections').createIndex('byNotebook', 'notebookId')
        tx.objectStore('objects').createIndex('byPage', 'pageId')
        tx.objectStore('tasks').createIndex('byProject', 'projectId')
      }
      req.onerror = () => reject(req.error)
      req.onsuccess = () => resolve(req.result)
    })
    db.onversionchange = () => {
      Reflect.set(window, 'legacyVersionChange', true)
      if (closeOnVersionChange) db.close()
    }
    // Keep the synthetic old connection alive until its tab closes (including GC).
    Reflect.set(window, 'legacyConnection', db)
    const tx = db.transaction([...db.objectStoreNames], 'readwrite')
    for (const [name, values] of Object.entries(records)) {
      if (name === 'workspace') tx.objectStore('settings').put(values, 'workspace')
      else for (const value of values as { id: string }[]) tx.objectStore(name).put(value)
    }
    for (const b of blobs) tx.objectStore('blobs').put(new Blob([new Uint8Array(b.bytes)]), b.id)
    tx.objectStore('settings').put({ revision: 42, lastChangeAt: records.pages[0].updatedAt }, 'activity')
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error) })
  }, { records, blobs, closeOnVersionChange })
  return records
}

for (const blocked of [true, false]) {
  test(`DB5 → DB6 preserves the complete workspace with ${blocked ? 'a blocking legacy tab closed later' : 'a cooperating legacy tab still open'}`, async ({ page: legacy, context }) => {
    const records = await openLegacy(legacy, !blocked)
    const before = await dumpWorkspace(legacy)
    const current = await context.newPage()
    await current.addInitScript(() => {
      const open = indexedDB.open.bind(indexedDB)
      indexedDB.open = (...args: Parameters<IDBFactory['open']>) => {
        const request = open(...args)
        request.addEventListener('blocked', () => Reflect.set(window, 'upgradeBlocked', true))
        return request
      }
    })
    await current.goto('/')
    await expect.poll(() => legacy.evaluate(() => Reflect.get(window, 'legacyVersionChange'))).toBe(true)
    if (blocked) {
      await expect.poll(() => current.evaluate(() => Reflect.get(window, 'upgradeBlocked'))).toBe(true)
      // The waiting tab says why it is waiting and what to do; it claims no
      // success (no save status, no workspace) and nothing was migrated yet.
      const waiting = current.getByRole('status').filter({ hasText: 'another Minty Notes window or tab is still using it' })
      await expect(waiting).toBeVisible()
      await expect(waiting).toContainText('Nothing has been changed yet.')
      await expect(current.getByText('Opening Minty Notes…', { exact: true })).toHaveCount(0)
      await expect(current.getByTestId('save-status')).toHaveCount(0)
      await expect(current.getByTestId('rail-projects')).toHaveCount(0)
      await expect(current.getByRole('alert')).toHaveCount(0)
      // Still DB5 and unmigrated while blocked. Read through the held connection:
      // a new open would queue behind the pending upgrade.
      expect(await legacy.evaluate(async () => {
        const db = Reflect.get(window, 'legacyConnection') as IDBDatabase
        const read = <T,>(store: string, key?: string) => new Promise<T>((resolve) => {
          const req = key ? db.transaction(store).objectStore(store).get(key) : db.transaction(store).objectStore(store).getAll()
          req.onsuccess = () => resolve(req.result as T)
        })
        const projects = await read<{ noteSort?: string }[]>('projects')
        return { version: db.version, format: (await read<{ formatVersion: number }>('settings', 'workspace')).formatVersion, projects: projects.length, sorted: projects.some((p) => 'noteSort' in p) }
      })).toEqual({ version: 5, format: records.workspace.formatVersion, projects: records.projects.length, sorted: false })
      // Closing the actual tab, without retry/reload, releases the pending open.
      await legacy.close()
    }
    await expect(current.getByTestId('rail-projects')).toBeVisible()
    await expect(current.getByTestId('upgrade-blocked')).toHaveCount(0)
    await waitSaved(current)
    const expected = structuredClone(before)
    for (const p of records.projects) expected.records.projects[p.id] = JSON.stringify({ ...p, noteSort: 'last-edited' })
    expect(await dumpWorkspace(current)).toEqual(expected) // every record + every blob SHA, exact counts/revision
    expect(await current.evaluate(async () => {
      const req = indexedDB.open('minty-notes')
      const db = await new Promise<IDBDatabase>((r) => { req.onsuccess = () => r(req.result) })
      const workspace = await new Promise<{ formatVersion: number }>((r) => {
        const read = db.transaction('settings').objectStore('settings').get('workspace')
        read.onsuccess = () => r(read.result)
      })
      db.close()
      return { version: db.version, format: workspace.formatVersion }
    })).toEqual({ version: 6, format: 5 })
    await current.getByTestId('rail-projects').click()
    await current.locator('.navigator').getByRole('button', { name: new RegExp(records.projects[0].name) }).click()
    await expect(current.getByLabel('Sort project notes')).toHaveValue('last-edited')
    // A cached DB5 app cannot reopen and write incompatible format-5 records.
    expect(await current.evaluate(() => new Promise<string>((resolve) => {
      const req = indexedDB.open('minty-notes', 5)
      req.onerror = () => resolve(req.error?.name ?? '')
      req.onsuccess = () => { req.result.close(); resolve('unexpected success') }
    }))).toBe('VersionError')
  })
}
