import { expect, test, type Page } from '@playwright/test'
import { addTextBox, newQuickNote, waitSaved } from './helpers'

test('a second window opens read-only and can take over editing', async ({ page, context }) => {
  await page.goto('/')
  await newQuickNote(page)
  await addTextBox(page, 'Edited in window one')
  await waitSaved(page)

  const second = await context.newPage()
  await second.goto('/')
  await expect(second.getByTestId('readonly-banner')).toBeVisible()
  await expect(second.getByTestId('quick-note')).toBeVisible()
  await second.getByTestId('quick-note').click()
  await expect(second.getByText(/read-only/).first()).toBeVisible()

  await second.getByRole('button', { name: 'Edit here instead' }).click()
  await expect(second.getByTestId('readonly-banner')).toBeHidden()
  await expect(page.getByTestId('readonly-banner')).toBeVisible()
  // The new editor window has the first window's saved text.
  await second.getByRole('button', { name: 'Inbox' }).click()
  await second.locator('.nav-page').first().click()
  await expect(second.locator('.obj-text')).toHaveText('Edited in window one')
})

test('failed writes are reported honestly, kept, and retried', async ({ page }) => {
  await page.goto('/')
  await newQuickNote(page)
  await waitSaved(page)
  // Simulate the browser refusing writes (e.g. disk full).
  await page.evaluate(() => {
    const w = window as unknown as { __put: typeof IDBObjectStore.prototype.put }
    w.__put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function () {
      throw new DOMException('Simulated full disk', 'QuotaExceededError')
    }
  })
  await addTextBox(page, 'Must not be lost')
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'error')
  await expect(page.getByTestId('save-error-banner')).toContainText('run out of storage')

  await page.evaluate(() => {
    const w = window as unknown as { __put: typeof IDBObjectStore.prototype.put }
    IDBObjectStore.prototype.put = w.__put
  })
  await page.getByRole('button', { name: 'Retry now' }).click()
  await waitSaved(page)
  await page.reload()
  await expect(page.locator('.obj-text')).toHaveText('Must not be lost')
})

test('invalid backup files are rejected without changing the workspace', async ({ page }) => {
  await page.goto('/')
  await newQuickNote(page)
  await addTextBox(page, 'Still here')
  await waitSaved(page)
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByTestId('restore-file').setInputFiles({ name: 'not-a-backup.zip', mimeType: 'application/zip', buffer: Buffer.from('this is not a zip file') })
  await expect(page.getByText('This backup cannot be restored. Nothing was changed.')).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: 'Inbox' }).click()
  await page.locator('.nav-page').first().click()
  await expect(page.locator('.obj-text')).toHaveText('Still here')
})

test.describe('backup folder (simulated directory handle)', () => {
  // Chrome's folder picker and permission prompts cannot be driven headlessly.
  // These tests replace showDirectoryPicker with a real FileSystemDirectoryHandle
  // from the origin-private file system, and patch permission answers.
  // They never reload: this environment's headless Chromium closes the page when
  // a stored directory handle is read back from IndexedDB (see docs/PROGRESS.md).
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.showDirectoryPicker = async () => {
        const root = await navigator.storage.getDirectory()
        return root.getDirectoryHandle('Dropbox-Backups', { create: true })
      }
    })
  })

  const listFolder = (page: Page) =>
    page.evaluate(async () => {
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle('Dropbox-Backups', { create: true })
      const out: { name: string; size: number }[] = []
      for await (const [name, h] of dir.entries()) if (h.kind === 'file') out.push({ name, size: (await (h as FileSystemFileHandle).getFile()).size })
      return out.sort((a, b) => a.name.localeCompare(b.name))
    })

  /** Make the browser answer permission checks/requests as given, then let the app re-check. */
  const setPermission = (page: Page, query: PermissionState, request: PermissionState = query) =>
    page.evaluate(
      ([q, r]) => {
        const proto = FileSystemHandle.prototype as unknown as Record<string, unknown>
        let current = q
        proto.queryPermission = async () => current
        proto.requestPermission = async () => {
          current = r
          return r
        }
        document.dispatchEvent(new Event('visibilitychange'))
      },
      [query, request] as const,
    )

  test('writes verified snapshots and recovers from revoked or denied access', async ({ page }) => {
    await page.goto('/')
    await newQuickNote(page)
    await addTextBox(page, 'Backed up note')
    await waitSaved(page)
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Choose backup folder…' }).click()
    await expect(page.getByTestId('last-backup')).toContainText('minty-notes-backup-')
    await expect(page.getByTestId('folder-state')).toContainText('Dropbox-Backups')
    let files = await listFolder(page)
    expect(files).toHaveLength(1)
    expect(files[0].size).toBeGreaterThan(200)

    // Restore picker lists folder snapshots, and a snapshot restores.
    await page.getByRole('button', { name: 'Restore from backup folder…' }).click()
    await expect(page.locator('.snapshot-list li')).toHaveCount(1)
    await page.locator('.snapshot-list').getByRole('button', { name: 'Restore…' }).click()
    await expect(page.getByTestId('restore-review')).toContainText('passed every check')
    await page.getByRole('button', { name: 'Cancel' }).click()

    // The browser revokes access (as after a restart): backups pause visibly.
    await setPermission(page, 'prompt', 'denied')
    await expect(page.getByTestId('reconnect-banner')).toBeVisible()
    await expect(page.getByTestId('backup-pill')).toHaveText('Backups paused')
    await expect(page.getByRole('button', { name: 'Back up now' })).toBeHidden()

    // The user refuses when asked.
    await page.getByTestId('reconnect-banner').getByRole('button', { name: 'Reconnect folder' }).click()
    await expect(page.getByText('Folder access was not granted.')).toBeVisible()
    expect(await listFolder(page)).toHaveLength(1)

    // The download fallback still works while the folder is unavailable.
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download backup' }).click()
    expect((await download).suggestedFilename()).toMatch(/\.zip$/)

    // The user grants access: the banner clears and backups resume.
    await setPermission(page, 'prompt', 'granted')
    await page.getByTestId('reconnect-banner').getByRole('button', { name: 'Reconnect folder' }).click()
    await expect(page.getByTestId('reconnect-banner')).toBeHidden()
    await page.getByRole('button', { name: 'Back up now' }).click()
    await expect.poll(async () => (await listFolder(page)).length).toBe(2)
    files = await listFolder(page)
    expect(files.every((f) => /^minty-notes-backup-\d{8}-\d{6}Z(-\d+)?\.zip$/.test(f.name))).toBe(true)
  })

  test('a write failure keeps older snapshots and reports the problem', async ({ page }) => {
    await page.goto('/')
    await newQuickNote(page)
    await addTextBox(page, 'Note')
    await waitSaved(page)
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Choose backup folder…' }).click()
    await expect(page.getByTestId('last-backup')).toContainText('minty-notes-backup-')
    const before = await listFolder(page)

    await page.evaluate(() => {
      FileSystemWritableFileStream.prototype.write = async function () {
        throw new DOMException('Simulated disk full', 'QuotaExceededError')
      }
    })
    await page.getByRole('button', { name: 'Back up now' }).click()
    await expect(page.getByTestId('backup-error')).toContainText('disk is full')
    expect(await listFolder(page)).toEqual(before)
  })
})
