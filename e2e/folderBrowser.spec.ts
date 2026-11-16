import { expect, test, type Page } from '@playwright/test'
import { dumpWorkspace, waitSaved } from './helpers'

async function openFiles(page: Page) {
  await page.goto('/')
  await page.getByTestId('rail-projects').click()
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  await page.getByLabel('Project name').fill('Folder browser fixture')
  await page.getByTestId('tab-files').click()
  await waitSaved(page)
}

test('folder browsing: actual OPFS enumeration, simulated picker and permissions; no workspace writes', async ({ page, context }) => {
  // Native picker/permission UI cannot be automated. The selected directory is
  // isolated OPFS fixture data, never a real work folder or Chrome profile.
  await context.addInitScript(() => {
    const sim = { query: 'granted' as PermissionState, request: 'granted' as PermissionState, modes: [] as string[] }
    Object.assign(window, { __folderSim: sim })
    FileSystemHandle.prototype.queryPermission = async (descriptor) => { sim.modes.push(descriptor?.mode ?? 'read'); return sim.query }
    FileSystemHandle.prototype.requestPermission = async (descriptor) => { sim.modes.push(descriptor?.mode ?? 'read'); sim.query = sim.request; return sim.request }
    window.showDirectoryPicker = async (options) => {
      sim.modes.push(options?.mode ?? 'read')
      const root = await navigator.storage.getDirectory()
      const folder = await root.getDirectoryHandle('Synthetic job', { create: true })
      const child = await folder.getDirectoryHandle('Drawings', { create: true })
      await child.getFileHandle('Panel.pdf', { create: true })
      await folder.getFileHandle('PLC.ACD', { create: true })
      // If the app tries to read file content it fails the interaction.
      FileSystemFileHandle.prototype.getFile = async () => { throw new Error('File bytes must not be read') }
      return folder
    }
  })
  await openFiles(page)
  const before = await dumpWorkspace(page)
  const browser = page.getByTestId('folder-browser')
  await browser.getByRole('button', { name: 'Choose folder to browse…' }).click()
  await expect(browser.getByRole('status')).toContainText('Synthetic job: 2 entries. Read-only.')
  await expect(browser.getByText('File: PLC.ACD', { exact: true })).toBeVisible()
  await browser.getByRole('button', { name: 'Folder: Drawings' }).focus()
  await page.keyboard.press('Enter')
  await expect(browser.getByText('File: Panel.pdf', { exact: true })).toBeVisible()
  await expect(browser.getByRole('status')).toBeFocused()
  await browser.getByRole('navigation', { name: 'Folder location' }).getByRole('button', { name: 'Synthetic job /' }).click()
  await expect(browser.getByText('File: PLC.ACD', { exact: true })).toBeVisible()

  // Refresh keeps keyboard focus on its own button.
  await browser.getByRole('button', { name: 'Refresh folder' }).focus()
  await page.keyboard.press('Enter')
  await expect(browser.getByRole('status')).toContainText('Synthetic job: 2 entries')
  await expect(browser.getByRole('button', { name: 'Refresh folder' })).toBeFocused()

  await page.evaluate(() => { (window as unknown as { __folderSim: { query: PermissionState } }).__folderSim.query = 'denied' })
  await browser.getByRole('button', { name: 'Refresh folder' }).click()
  await expect(browser.getByRole('status')).toContainText('Folder permission denied: the browser is not allowing Minty Notes to read this folder')
  await expect(browser.getByRole('list', { name: 'Folder entries' })).toHaveCount(0)
  await expect(browser.getByRole('button', { name: 'Reconnect folder browsing', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(browser.getByText('File: PLC.ACD', { exact: true })).toBeVisible()
  await expect(browser.getByRole('button', { name: 'Refresh folder', exact: true })).toBeFocused()
  const modes = await page.evaluate(() => (window as unknown as { __folderSim: { modes: string[] } }).__folderSim.modes)
  expect(modes.length).toBeGreaterThan(3)
  expect(modes.every((mode) => mode === 'read')).toBe(true)
  expect(await dumpWorkspace(page)).toEqual(before)

  await browser.getByRole('button', { name: 'Stop browsing this folder', exact: true }).click()
  await expect(browser.getByRole('button', { name: 'Choose folder to browse…' })).toBeFocused()
  await expect(browser.getByRole('status')).toContainText('The browser’s own access permission for this site is not changed by this')
  // A cancelled picker returns focus to the button that opened it.
  await page.evaluate(() => {
    const original = window.showDirectoryPicker!
    window.showDirectoryPicker = async () => { window.showDirectoryPicker = original; throw new DOMException('cancelled', 'AbortError') }
  })
  await browser.getByRole('button', { name: 'Choose folder to browse…' }).click()
  await expect(browser.getByRole('button', { name: 'Choose folder to browse…' })).toBeFocused()
  await browser.getByRole('button', { name: 'Choose folder to browse…' }).click()
  await expect(browser.getByText('File: PLC.ACD', { exact: true })).toBeVisible()

  // Also available in a read-only application window, without requesting ownership.
  const second = await context.newPage()
  await second.goto('/')
  await expect(second.getByTestId('readonly-banner')).toBeVisible()
  await expect(second.getByRole('button', { name: 'Choose folder to browse…' })).toBeEnabled()
  await second.close()
  await page.reload()
  await expect(page.getByTestId('folder-browser').getByRole('status')).toHaveText('No folder selected.')
  expect(await dumpWorkspace(page)).toEqual(before)
})

test('unsupported folder browsing preserves saved path and link actions', async ({ page }) => {
  await page.addInitScript(() => { window.showDirectoryPicker = undefined })
  await openFiles(page)
  await expect(page.getByTestId('folder-browser')).toContainText('Folder browsing is unavailable in this browser')
  await page.getByRole('button', { name: 'Add local path', exact: true }).click()
  await page.getByLabel('Name of location 1').fill('Job path')
  await page.getByLabel('Path of location 1').fill('C:\\Jobs\\J100')
  await page.getByRole('button', { name: 'Copy Job path' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('C:\\Jobs\\J100')
  await page.getByRole('button', { name: 'Add web link', exact: true }).click()
  await page.getByLabel('Link of location 2').fill('https://example.com/project')
  await expect(page.getByRole('link', { name: 'Open link in a new tab' })).toHaveAttribute('href', 'https://example.com/project')
})

test('focus returns to Refresh/Reconnect and Choose after delayed directory operations, whatever the frame timing', async ({ page, context }) => {
  // Regression for the intermittent focus failure: the focused button is disabled while
  // the folder is read. Here every directory operation is delayed, and on request the next
  // animation frame runs before React has committed `busy = false` (the order that occurs
  // intermittently in a real browser). Focus must still land on the enabled button.
  await context.addInitScript(() => {
    const sim = { query: 'granted' as PermissionState, request: 'granted' as PermissionState, delayMs: 150, earlyFrame: false, cancelNext: false }
    Object.assign(window, { __folderSim: sim })
    const pause = () => new Promise((resolve) => setTimeout(resolve, sim.delayMs))
    const raf = window.requestAnimationFrame.bind(window)
    window.requestAnimationFrame = (cb) => {
      if (!sim.earlyFrame) return raf(cb)
      sim.earlyFrame = false
      queueMicrotask(() => cb(performance.now()))
      return 0
    }
    FileSystemHandle.prototype.queryPermission = async () => { await pause(); return sim.query }
    FileSystemHandle.prototype.requestPermission = async () => { await pause(); sim.query = sim.request; return sim.request }
    window.showDirectoryPicker = async () => {
      await pause()
      if (sim.cancelNext) { sim.cancelNext = false; throw new DOMException('cancelled', 'AbortError') }
      const root = await navigator.storage.getDirectory()
      const folder = await root.getDirectoryHandle('Delayed job', { create: true })
      await folder.getFileHandle('Wiring.pdf', { create: true })
      return folder
    }
  })
  await openFiles(page)
  const browser = page.getByTestId('folder-browser')
  const sim = (patch: Record<string, unknown>) => page.evaluate((p) => Object.assign((window as unknown as { __folderSim: object }).__folderSim, p), patch)
  await browser.getByRole('button', { name: 'Choose folder to browse…' }).click()
  await expect(browser.getByText('File: Wiring.pdf', { exact: true })).toBeVisible()

  for (let round = 0; round < 3; round++) {
    await sim({ earlyFrame: true })
    await browser.getByRole('button', { name: 'Refresh folder', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(browser.getByRole('status')).toContainText('Delayed job: 1 entries')
    await expect(browser.getByRole('button', { name: 'Refresh folder', exact: true })).toBeFocused()
  }

  await sim({ query: 'denied' })
  await sim({ earlyFrame: true })
  await browser.getByRole('button', { name: 'Refresh folder', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(browser.getByRole('status')).toContainText('Folder permission denied')
  await expect(browser.getByRole('button', { name: 'Reconnect folder browsing', exact: true })).toBeEnabled()
  await expect(browser.getByRole('button', { name: 'Reconnect folder browsing', exact: true })).toBeFocused()
  await sim({ request: 'granted', earlyFrame: true })
  await page.keyboard.press('Enter')
  await expect(browser.getByText('File: Wiring.pdf', { exact: true })).toBeVisible()
  await expect(browser.getByRole('button', { name: 'Refresh folder', exact: true })).toBeFocused()

  // A cancelled picker returns focus to its (re-enabled) button under the same timing.
  await sim({ cancelNext: true, earlyFrame: true })
  await browser.getByRole('button', { name: 'Choose another folder…' }).focus()
  await page.keyboard.press('Enter')
  await expect(browser.getByRole('button', { name: 'Choose another folder…' })).toBeFocused()
})
