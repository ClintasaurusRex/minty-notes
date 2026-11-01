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

const breakWrites = (p: Page) =>
  p.evaluate(() => {
    const w = window as unknown as { __put: typeof IDBObjectStore.prototype.put }
    w.__put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function () {
      throw new DOMException('Simulated full disk', 'QuotaExceededError')
    }
  })
const fixWrites = (p: Page) =>
  p.evaluate(() => {
    IDBObjectStore.prototype.put = (window as unknown as { __put: typeof IDBObjectStore.prototype.put }).__put
  })

test('a handover is refused while the editing window cannot save, and its work is kept', async ({ page, context }) => {
  await page.goto('/')
  await newQuickNote(page)
  const box = await addTextBox(page, 'Saved first')
  await waitSaved(page)
  await breakWrites(page)
  await box.locator('.rt').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' + unsaved')
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'error')

  const second = await context.newPage()
  await second.goto('/')
  await second.getByRole('button', { name: 'Edit here instead' }).click()
  await expect(second.getByText(/Could not start editing here/)).toBeVisible()
  await expect(second.getByTestId('readonly-banner')).toBeVisible()
  // The first window still edits, with its unsaved text intact.
  await expect(page.getByTestId('readonly-banner')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Add text box' })).toBeEnabled()
  await expect(page.locator('.obj-text')).toHaveText('Saved first + unsaved')

  // Once storage works again the change saves, and handing over loses nothing.
  await fixWrites(page)
  await page.getByRole('button', { name: 'Retry now' }).click()
  await waitSaved(page)
  await second.getByRole('button', { name: 'Edit here instead' }).click()
  await expect(second.getByTestId('readonly-banner')).toBeHidden()
  await expect(page.getByTestId('readonly-banner')).toBeVisible()
  await second.getByRole('button', { name: 'Inbox' }).click()
  await second.locator('.nav-page').first().click()
  await expect(second.locator('.obj-text')).toHaveText('Saved first + unsaved')
})

test('a frozen editing window that loses the lock stops writing and keeps its edits aside', async ({ context }) => {
  const a = await context.newPage()
  // Window A cannot hear handover requests, like a frozen background tab.
  await a.addInitScript(() => Object.defineProperty(window, 'BroadcastChannel', { value: undefined }))
  await a.goto('/')
  await newQuickNote(a)
  const boxA = await addTextBox(a, 'From A')
  await waitSaved(a)
  await breakWrites(a)
  await boxA.locator('.rt').click()
  await a.keyboard.press('End')
  await a.keyboard.type(' (held)')
  await expect(a.getByTestId('save-status')).toHaveAttribute('data-status', 'error')

  // Window B gets no answer, takes the lock after the timeout, and edits.
  const b = await context.newPage()
  await b.goto('/')
  await b.getByRole('button', { name: 'Edit here instead' }).click()
  await expect(b.getByTestId('readonly-banner')).toBeHidden({ timeout: 15_000 })

  // A is now read-only everywhere, with its unsaved edit held, not written.
  await expect(a.getByTestId('readonly-banner')).toHaveAttribute('data-held', /^[1-9]/)
  await expect(a.getByRole('button', { name: 'Add text box' })).toBeDisabled()
  await expect(a.locator('.obj-text .rt')).toHaveAttribute('contenteditable', 'false')
  await fixWrites(a)
  // Even with storage working, A's queued edits are not written (no retries, no flush on hide).
  await a.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await b.getByRole('button', { name: 'Inbox' }).click()
  await b.locator('.nav-page').first().click()
  await expect(b.locator('.obj-text')).toHaveText('From A')
  await addTextBox(b, 'From B')
  await waitSaved(b)
  await b.reload()
  await expect(b.locator('.obj-text').first()).toHaveText('From A')

  // A takes editing back on purpose: its held edit is saved on top of B's work.
  await a.getByRole('button', { name: 'Edit here and save them' }).click()
  await expect(a.getByTestId('readonly-banner')).toBeHidden({ timeout: 15_000 })
  await waitSaved(a)
  await expect(a.locator('.obj-text').filter({ hasText: 'From A (held)' })).toHaveCount(1)
  await expect(a.locator('.obj-text').filter({ hasText: 'From B' })).toHaveCount(1)
  await b.reload()
  await expect(b.locator('.obj-text').filter({ hasText: 'From A (held)' })).toHaveCount(1)
  await expect(b.locator('.obj-text').filter({ hasText: 'From B' })).toHaveCount(1)
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
      for await (const [name, h] of dir.entries()) {
        // Skip Chrome's temporary swap files and entries that vanish while a write finishes.
        if (h.kind !== 'file' || name.endsWith('.crswap')) continue
        try {
          out.push({ name, size: (await (h as FileSystemFileHandle).getFile()).size })
        } catch {
          // gone mid-listing
        }
      }
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
