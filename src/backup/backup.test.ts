import { strToU8, zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { docFromPlainText } from '../domain/richtext'
import { newId, nowIso, type ImageObject, type TextObject } from '../domain/types'
import { freshStore, PNG_1x1 } from '../test/fixtures'
import { WorkspaceStore } from '../store/workspaceStore'
import { buildStage1Archive, toStage1Records } from '../test/legacy'
import { buildArchive, readArchive, sha256Hex } from './archive'
import { BackupService } from './backupService'
import { isSnapshotName, snapshotFileName } from './folder'

/** A snapshot name in the pre-0.5.0 UTC format (seconds resolution), as older versions wrote it. */
function legacyName(date: Date): string {
  return `minty-notes-backup-${date.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}Z.zip`
}

/** Simulated directory handle. It exercises our logic, not Chrome's real permission UI. */
class FakeDir {
  name = 'Dropbox Backups'
  files = new Map<string, Uint8Array>()
  permission: PermissionState = 'granted'
  requestResult: PermissionState = 'granted'
  failWrite: Error | null = null
  truncateReadBack = false
  beforeClose: (() => Promise<void>) | null = null
  async queryPermission() {
    return this.permission
  }
  async requestPermission() {
    this.permission = this.requestResult
    return this.permission
  }
  async *keys() {
    yield* [...this.files.keys()]
  }
  async removeEntry(name: string) {
    this.files.delete(name)
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    if (this.permission !== 'granted') throw new DOMException('denied', 'NotAllowedError')
    if (!this.files.has(name)) {
      if (!opts?.create) throw new DOMException('missing', 'NotFoundError')
      this.files.set(name, new Uint8Array())
    }
    return {
      createWritable: async () => {
        let pending: Uint8Array | null = null
        return {
          write: async (b: Uint8Array) => {
            if (this.failWrite) throw this.failWrite
            pending = b
          },
          close: async () => {
            await this.beforeClose?.()
            this.files.set(name, pending ?? new Uint8Array())
          },
          abort: async () => undefined,
        }
      },
      getFile: async () => new Blob([(this.truncateReadBack ? this.files.get(name)!.subarray(0, 1) : this.files.get(name)!) as Uint8Array<ArrayBuffer>]),
    }
  }
}

async function sampleWorkspace() {
  const { store, repo } = await freshStore()
  const { notebook, section } = store.createNotebook('Studio 5000')
  const page = store.createPage({ kind: 'inbox' })
  const filed = store.createPage({ kind: 'section', sectionId: section.id }, 'Rack layout')
  const at = nowIso()
  const text: TextObject = { id: newId(), pageId: page.id, type: 'text', x: 48, y: 48, w: 420, h: 72, z: 1, doc: docFromPlainText('Remember the VFD fault code'), createdAt: at, updatedAt: at }
  const attachmentId = newId()
  await store.addAttachment(
    { id: attachmentId, fileName: 'screenshot.png', mimeType: 'image/png', size: PNG_1x1.byteLength, sha256: await sha256Hex(PNG_1x1), width: 1, height: 1, source: 'paste', createdAt: at },
    new Blob([PNG_1x1], { type: 'image/png' }),
  )
  const image: ImageObject = { id: newId(), pageId: page.id, type: 'image', attachmentId, alt: '', x: 520, y: 160, w: 300, h: 200, z: 2, createdAt: at, updatedAt: at }
  store.addObjects(page.id, [text, image])
  await store.flush()
  return { store, repo, notebook, section, page, filed, text, image, attachmentId }
}

/** A controllable monotonic clock (milliseconds). */
function fakeClock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => void (t += ms) }
}

function serviceFor(store: Awaited<ReturnType<typeof freshStore>>['store'], dir?: FakeDir, clock = fakeClock()) {
  const downloads: { bytes: Uint8Array; fileName: string }[] = []
  const service = new BackupService(store, {
    appVersion: 'test',
    folderSupported: true,
    pickFolder: async () => (dir ?? null) as unknown as FileSystemDirectoryHandle | null,
    download: (bytes, fileName) => downloads.push({ bytes, fileName }),
    monotonicNow: clock.now,
  })
  return { service, downloads, clock }
}

describe('complete backup and restore', () => {
  it('restores notes, image bytes, layout, and notebook links into a clean workspace', async () => {
    const src = await sampleWorkspace()
    const { service, downloads } = serviceFor(src.store)
    await service.init()
    const result = await service.downloadBackup()
    expect(result.ok).toBe(true)
    expect(downloads).toHaveLength(1)

    const validated = await readArchive(downloads[0].bytes)
    if (!validated.ok) throw new Error(validated.errors.join('\n'))
    expect(validated.summary.counts).toEqual({ projects: 0, tasks: 0, templates: 0, categories: 0, tags: 0, notebooks: 1, sections: 1, pages: 2, objects: 2, attachments: 1 })

    // Clean workspace in a separate database.
    const clean = await freshStore()
    expect(Object.keys(clean.store.getState().data.pages)).toHaveLength(0)
    const target = serviceFor(clean.store)
    await target.service.init()
    await target.service.restore(validated)

    const data = clean.store.getState().data
    expect(data.workspace?.workspaceId).toBe(src.store.getState().data.workspace?.workspaceId)
    expect(data.pages[src.filed.id].location).toEqual({ kind: 'section', sectionId: src.section.id })
    expect(data.sections[src.section.id].notebookId).toBe(src.notebook.id)
    const objects = await clean.store.ensurePageObjects(src.page.id)
    expect(objects[src.text.id]).toMatchObject({ x: 48, y: 48, w: 420 })
    expect((objects[src.text.id] as TextObject).doc).toEqual(src.text.doc)
    expect(objects[src.image.id]).toMatchObject({ x: 520, y: 160, w: 300, h: 200, attachmentId: src.attachmentId })
    const blob = await clean.store.getBlob(src.attachmentId)
    expect(await sha256Hex(new Uint8Array(await blob!.arrayBuffer()))).toBe(await sha256Hex(PNG_1x1))
    // The (empty) previous workspace was kept as a safeguard.
    expect(target.service.getState().safeguard?.fileName).toMatch(/^minty-notes-before-restore-/)
  })

  it('leaves the existing workspace untouched when applying a restore fails', async () => {
    const src = await sampleWorkspace()
    const { bytes } = await serviceFor(src.store).service.createArchive()
    const validated = await readArchive(bytes)
    if (!validated.ok) throw new Error('expected valid')

    const target = await freshStore()
    const existing = target.store.createPage({ kind: 'standalone' }, 'Keep me')
    await target.store.flush()
    const { service } = serviceFor(target.store)
    await service.init()
    vi.spyOn(target.repo, 'replaceAll').mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'))
    await expect(service.restore(validated)).rejects.toThrow()
    await target.store.load()
    expect(target.store.getState().data.pages[existing.id]?.title).toBe('Keep me')
    expect(target.store.getState().data.pages[src.page.id]).toBeUndefined()
  })
})

describe('archive validation', () => {
  async function validArchiveFiles() {
    const src = await sampleWorkspace()
    const { records, blobs } = await src.store.repository.readAll()
    return { src, records, blobs }
  }

  it('rejects files that are not backups', async () => {
    const notZip = await readArchive(strToU8('hello'))
    expect(notZip.ok).toBe(false)
    const noManifest = await readArchive(zipSync({ 'other.txt': strToU8('x') }))
    expect(noManifest).toMatchObject({ ok: false })
    const wrongFormat = await readArchive(zipSync({ 'manifest.json': strToU8(JSON.stringify({ format: 'something-else' })) }))
    expect(wrongFormat).toMatchObject({ ok: false, errors: [expect.stringMatching(/not a Minty Notes backup/)] })
    const truncated = await readArchive(new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]))
    expect(truncated.ok).toBe(false)
  })

  it('rejects backups from a newer format version', async () => {
    const result = await readArchive(zipSync({ 'manifest.json': strToU8(JSON.stringify({ format: 'minty-notes-backup', formatVersion: 99 })) }))
    expect(result).toMatchObject({ ok: false, errors: [expect.stringMatching(/newer version/)] })
  })

  it('detects tampered records and damaged attachments', async () => {
    const { records, blobs } = await validArchiveFiles()
    const good = await buildArchive(records, blobs, 'test')
    const { unzipSync } = await import('fflate')
    const files = unzipSync(good)

    const tampered = { ...files, 'records.json': strToU8(new TextDecoder().decode(files['records.json']).replace('Studio 5000', 'Studio 9000')) }
    expect(await readArchive(zipSync(tampered))).toMatchObject({ ok: false, errors: [expect.stringMatching(/checksum/)] })

    const imagePath = Object.keys(files).find((f) => f.startsWith('attachments/'))!
    const damaged = { ...files, [imagePath]: new Uint8Array([1, 2, 3]) }
    expect(await readArchive(zipSync(damaged))).toMatchObject({ ok: false, errors: [expect.stringMatching(/damaged/)] })

    const missing = { ...files }
    delete missing[imagePath]
    expect(await readArchive(zipSync(missing))).toMatchObject({ ok: false, errors: [expect.stringMatching(/missing from the archive/)] })
  })

  it('detects broken relationships and invalid rich text', async () => {
    const { records, blobs } = await validArchiveFiles()
    const orphan = { ...records, objects: records.objects.map((o) => ({ ...o, pageId: 'nope' })) }
    const r1 = await readArchive(await buildArchive(orphan, blobs, 'test'))
    expect(r1).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringMatching(/missing page/)]) })

    const badSection = { ...records, sections: records.sections.map((s) => ({ ...s, notebookId: 'gone' })) }
    const r2 = await readArchive(await buildArchive(badSection, blobs, 'test'))
    expect(r2).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringMatching(/missing notebook/)]) })

    const badDoc = {
      ...records,
      objects: records.objects.map((o) => (o.type === 'text' ? { ...o, doc: { type: 'doc', content: [{ type: 'script', text: 'alert(1)' }] } } : o)),
    }
    const r3 = await readArchive(await buildArchive(badDoc as typeof records, blobs, 'test'))
    expect(r3).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringMatching(/not valid/)]) })

    const dup = { ...records, pages: [...records.pages, records.pages[0]] }
    const r4 = await readArchive(await buildArchive(dup, blobs, 'test'))
    expect(r4).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringMatching(/Duplicate page/)]) })
  })

  it('ignores unexpected archive entries with a warning, but refuses unsafe paths', async () => {
    const { records, blobs } = await validArchiveFiles()
    const { unzipSync } = await import('fflate')
    const files = unzipSync(await buildArchive(records, blobs, 'test'))
    // Left behind when a backup is unpacked and zipped again: still restorable, the extras are named.
    const result = await readArchive(zipSync({ ...files, 'extra.bin': strToU8('y'), '__MACOSX/._records.json': strToU8('z'), 'attachments/': new Uint8Array(0) }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.warnings).toEqual(expect.arrayContaining(['Ignored unexpected file: extra.bin', 'Ignored unexpected file: __MACOSX/._records.json']))
    // A path that would escape a folder is never part of a backup: the whole archive is refused (since 0.4.2).
    const unsafe = await readArchive(zipSync({ ...files, '../evil.txt': strToU8('x') }))
    expect(unsafe).toMatchObject({ ok: false, errors: [expect.stringMatching(/unsafe file path \("\.\.\/evil\.txt"\)/)] })
  })
})

/** Make `n` real snapshots through the service, each after a saved change, so each is recorded in the ledger. */
async function recordedBackups(service: BackupService, store: WorkspaceStore, pageId: string, n: number): Promise<string[]> {
  const names: string[] = []
  for (let i = 0; i < n; i++) {
    store.renamePage(pageId, `Revision ${names.length + 1} ${Math.random()}`)
    await store.flush()
    const result = await service.backupNow()
    if (!result.ok) throw new Error(result.message)
    names.push(result.fileName)
  }
  return names
}

describe('backup folder snapshots (simulated directory handle)', () => {
  it.each(['write', 'close', 'size verification'] as const)('preserves existing snapshot bytes and last success after failed %s, and a verified retry removes no unrecorded file', async (phase) => {
    const { store, repo, page } = await sampleWorkspace()
    const dir = new FakeDir()
    const { service } = serviceFor(store, dir)
    await service.init()
    expect(await service.chooseFolder()).toMatchObject({ ok: true })
    const lastSuccess = service.getState().status.lastBackup
    for (let i = 1; i <= 12; i++) dir.files.set(snapshotFileName(new Date(Date.UTC(2026, 0, i))), new Uint8Array([i]))
    dir.files.set('keep.txt', new Uint8Array([42]))
    const before = [...dir.files.entries()]
    store.renamePage(page.id, 'Needs a new backup')
    await store.flush()
    const remove = vi.spyOn(dir, 'removeEntry')
    const fail = new DOMException('disk full', 'QuotaExceededError')
    if (phase === 'write') dir.failWrite = fail
    if (phase === 'close') dir.beforeClose = async () => { throw fail }
    if (phase === 'size verification') dir.truncateReadBack = true

    const failed = await service.backupNow()
    expect(failed).toMatchObject({ ok: false, message: expect.stringMatching(phase === 'size verification' ? /wrong size/ : /disk is full/) })
    // A failure deletes nothing: every existing file is unchanged, and the attempt's own
    // output (empty, or unverified) stays under a new name that the message reports.
    expect(remove).not.toHaveBeenCalled()
    for (const [name, bytes] of before) expect(dir.files.get(name)).toEqual(bytes)
    const leftover = [...dir.files.keys()].filter((name) => !before.some(([old]) => old === name))
    expect(leftover).toHaveLength(1)
    expect(failed).toMatchObject({ message: expect.stringContaining(`The file ${leftover[0]} in the backup folder could not be confirmed`) })
    expect(service.getState().status.lastBackup).toEqual(lastSuccess)
    expect(service.getState().status.lastError?.message).toMatch(phase === 'size verification' ? /wrong size/ : /disk is full/)
    expect(await repo.getSetting('backupStatus')).toEqual(service.getState().status)
    expect(service.hasUnbackedChanges()).toBe(true)
    expect(service.getState().running).toBeNull()

    dir.failWrite = null
    dir.truncateReadBack = false
    dir.beforeClose = async () => { expect([...dir.files.entries()].filter(([name]) => before.some(([old]) => old === name))).toEqual(before) }
    remove.mockClear()
    const result = await service.backupNow()
    if (!result.ok) throw new Error(result.message)
    // The 12 copied-in files and the failed attempt's file were never recorded as verified
    // backups: none of them counts towards the 10, and none is removed.
    expect(remove).not.toHaveBeenCalled()
    expect([...dir.files.keys()].sort()).toEqual([...before.map(([name]) => name), leftover[0], result.fileName].sort())
    for (const [name, bytes] of before) expect(dir.files.get(name)).toEqual(bytes)
    expect(service.getState().status.cleanupWarning?.message).toMatch(/holds 15 snapshots, more than the 10.*13 were not written and verified by Minty Notes.*only 2 verified backups/)
    const archive = await readArchive(dir.files.get(result.fileName)!)
    if (!archive.ok) throw new Error(archive.errors.join('; '))
    expect(archive.records.pages.find((p) => p.id === page.id)?.title).toBe('Needs a new backup')
    expect(service.getState().status).toMatchObject({ lastBackup: { fileName: result.fileName, revision: store.getState().data.revision }, lastError: null })
    expect(await repo.getSetting('backupStatus')).toEqual(service.getState().status)
    expect(service.hasUnbackedChanges()).toBe(false)
  })

  it('writes verified snapshots and keeps the 10 most recently recorded ones', async () => {
    const src = await sampleWorkspace()
    const dir = new FakeDir()
    dir.files.set('notes.txt', new Uint8Array([1]))
    const { service } = serviceFor(src.store, dir)
    await service.init()
    const first = await service.chooseFolder()
    if (!first?.ok) throw new Error(first?.message)
    const names = [first.fileName, ...(await recordedBackups(service, src.store, src.page.id, 12))]
    expect([...dir.files.keys()].filter(isSnapshotName).sort()).toEqual(names.slice(-10).sort())
    // Unrelated files in the folder are never touched.
    expect(dir.files.has('notes.txt')).toBe(true)
    for (const name of names.slice(-10)) expect((await readArchive(dir.files.get(name)!)).ok).toBe(true)
    expect(service.getState().status).toMatchObject({ lastBackup: { fileName: names.at(-1) }, cleanupWarning: null })
    // The ledger only lists what is in the folder.
    const ledger = await src.repo.getSetting<{ entries: { fileName: string }[] }>('backupLedger')
    expect(ledger?.entries.map((e) => e.fileName).sort()).toEqual(names.slice(-10).sort())
  })

  it('never deletes snapshots it did not write and verify (older versions, copies) and warns instead', async () => {
    const src = await sampleWorkspace()
    const dir = new FakeDir()
    for (let i = 0; i < 12; i++) dir.files.set(legacyName(new Date(Date.UTC(2026, 0, 1, 0, 0, i))), new Uint8Array([i]))
    const before = [...dir.files.entries()]
    const { service } = serviceFor(src.store, dir)
    await service.init()
    const remove = vi.spyOn(dir, 'removeEntry')
    const result = await service.chooseFolder()
    if (!result?.ok) throw new Error(result?.message)
    expect(remove).not.toHaveBeenCalled()
    for (const [name, bytes] of before) expect(dir.files.get(name)).toEqual(bytes)
    expect(service.getState().status.cleanupWarning?.message).toMatch(/holds 13 snapshots, more than the 10 Minty Notes keeps.*12 were not written and verified by Minty Notes in this browser.*delete snapshots you no longer need yourself/)
    expect((await src.repo.getSetting<{ cleanupWarning: unknown }>('backupStatus'))?.cleanupWarning).toEqual(service.getState().status.cleanupWarning)
  })

  it('never overwrites or cleans up an existing snapshot with the same name, even when the new write fails', async () => {
    const { store, page } = await sampleWorkspace()
    const dir = new FakeDir()
    const { service } = serviceFor(store, dir)
    await service.init()
    expect(await service.chooseFolder()).toMatchObject({ ok: true })
    // Two backups within the same minute (snapshot names have 1-minute resolution).
    const second = new Date('2026-03-04T05:06:07.000Z')
    const taken = snapshotFileName(second)
    const sentinel = new Uint8Array([7, 7, 7])
    dir.files.set(taken, sentinel)
    const before = [...dir.files.entries()]
    store.renamePage(page.id, 'Same-second backup')
    await store.flush()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(second)
      dir.failWrite = new DOMException('disk full', 'QuotaExceededError')
      const remove = vi.spyOn(dir, 'removeEntry')
      expect(await service.backupNow()).toMatchObject({ ok: false, message: expect.stringMatching(/disk is full/) })
      // The failed attempt used its own name and deleted nothing (it cannot prove that file is its own).
      expect(remove).not.toHaveBeenCalled()
      for (const [name, bytes] of before) expect(dir.files.get(name)).toEqual(bytes)
      expect(dir.files.get(taken.replace(/\.zip$/, '-2.zip'))).toEqual(new Uint8Array())
      dir.failWrite = null
      const result = await service.backupNow()
      if (!result.ok) throw new Error(result.message)
      expect(result.fileName).toBe(taken.replace(/\.zip$/, '-3.zip'))
    } finally { vi.useRealTimers() }
    expect(dir.files.get(taken)).toBe(sentinel)
    for (const [name, bytes] of before) expect(dir.files.get(name)).toEqual(bytes)
    expect(isSnapshotName(taken.replace(/\.zip$/, '-3.zip'))).toBe(true)
  })

  it('reports a verified backup truthfully when an old snapshot cannot be deleted, keeps that snapshot, and warns', async () => {
    const src = await sampleWorkspace()
    const dir = new FakeDir()
    const { service } = serviceFor(src.store, dir)
    await service.init()
    const first = await service.chooseFolder()
    if (!first?.ok) throw new Error(first?.message)
    const names = [first.fileName, ...(await recordedBackups(service, src.store, src.page.id, 9))]
    const stuck = names[0]
    const stuckBytes = dir.files.get(stuck)
    const remove = vi.spyOn(dir, 'removeEntry').mockImplementation(async (name: string) => {
      if (name === stuck) throw new DOMException('in use', 'NoModificationAllowedError')
      dir.files.delete(name)
    })
    const [eleventh] = await recordedBackups(service, src.store, src.page.id, 1)
    expect(remove.mock.calls.map(([name]) => name)).toEqual([stuck])
    const [twelfth] = await recordedBackups(service, src.store, src.page.id, 1)
    // 12 recorded, keep 10: the two oldest are attempted, oldest first; the stuck one stays.
    expect(remove.mock.calls.map(([name]) => name)).toEqual([stuck, stuck, names[1]])
    expect(dir.files.get(stuck)).toBe(stuckBytes)
    expect([...dir.files.keys()].sort()).toEqual([stuck, ...names.slice(2), eleventh, twelfth].sort())
    expect((await readArchive(dir.files.get(twelfth)!)).ok).toBe(true)
    expect(service.getState().status).toMatchObject({ lastBackup: { fileName: twelfth }, lastError: null, cleanupWarning: { message: expect.stringMatching(/holds 11 snapshots.*1 could not be deleted because the folder refused/) } })
    expect(await src.repo.getSetting('backupStatus')).toEqual(service.getState().status)
  })

  it('does not prune or report success when the write fails', async () => {
    const src = await sampleWorkspace()
    const dir = new FakeDir()
    // More than `keep`, in both name formats: a failed write must still remove none of them.
    for (let i = 0; i < 6; i++) dir.files.set(legacyName(new Date(Date.UTC(2026, 0, 1, 0, 0, i))), new Uint8Array([i]))
    for (let i = 0; i < 6; i++) dir.files.set(snapshotFileName(new Date(Date.UTC(2026, 0, 2, i))), new Uint8Array([i]))
    const before = [...dir.files.keys()].sort()
    expect(before).toHaveLength(12)
    dir.failWrite = new DOMException('disk full', 'QuotaExceededError')
    const { service } = serviceFor(src.store, dir)
    await service.init()
    const remove = vi.spyOn(dir, 'removeEntry')
    const result = await service.chooseFolder()
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/disk is full/) })
    expect(remove).not.toHaveBeenCalled()
    // Only the attempt's own (empty) output was added.
    expect([...dir.files.keys()].filter((name) => !before.includes(name)).map((name) => dir.files.get(name)!.byteLength)).toEqual([0])
    expect(service.getState().status.lastBackup).toBeNull()
    expect(service.getState().status.lastError?.message).toMatch(/disk is full/)
  })

  it('handles denied and revoked folder permission without losing data', async () => {
    const src = await sampleWorkspace()
    const dir = new FakeDir()
    dir.permission = 'prompt'
    dir.requestResult = 'denied'
    const { service, downloads } = serviceFor(src.store, dir)
    await service.init()
    expect(await service.chooseFolder()).toMatchObject({ ok: false })
    expect(service.getState().folderState).toBe('denied')

    // Later the user grants access; then the browser revokes it again.
    dir.requestResult = 'granted'
    expect(await service.reconnectFolder()).toMatchObject({ ok: true })
    expect(service.getState().folderState).toBe('granted')
    dir.permission = 'prompt'
    await service.refreshPermission()
    expect(service.getState().folderState).toBe('prompt')
    expect(await service.backupNow()).toMatchObject({ ok: false, message: expect.stringMatching(/Reconnect/) })
    // The downloadable fallback still works.
    expect(await service.downloadBackup()).toMatchObject({ ok: true })
    expect(downloads).toHaveLength(1)
    expect(Object.keys(src.store.getState().data.pages)).toHaveLength(2)
  })

  it('runs automatic snapshots only when changes exist and the interval has passed', async () => {
    const src = await sampleWorkspace()
    const dir = new FakeDir()
    const { service, clock } = serviceFor(src.store, dir)
    await service.init()
    await service.chooseFolder()
    const count = () => [...dir.files.keys()].filter(isSnapshotName).length
    expect(count()).toBe(1)
    // Nothing changed since the snapshot: never due, however long we wait.
    clock.advance(service.intervalMs * 5)
    expect(service.isDue()).toBe(false)

    src.store.renamePage(src.page.id, 'Changed')
    await src.store.flush()
    clock.advance(-service.intervalMs * 5) // back to the snapshot moment
    clock.advance(60_000)
    expect(service.isDue()).toBe(false)
    clock.advance(service.intervalMs)
    expect(service.isDue()).toBe(true)
    await service.tick()
    expect(count()).toBe(2)
    expect(service.isDue()).toBe(false)

    // Read-only windows never write snapshots.
    src.store.renamePage(src.page.id, 'Changed again')
    await src.store.flush()
    src.store.setReadOnly(true)
    clock.advance(service.intervalMs * 2)
    await service.tick()
    expect(count()).toBe(2)
    expect(await service.backupNow()).toMatchObject({ ok: false })
  })
})

describe('backup revision tracking (clock-independent)', () => {
  async function connected() {
    const src = await sampleWorkspace()
    const dir = new FakeDir()
    const svc = serviceFor(src.store, dir)
    await svc.service.init()
    await svc.service.chooseFolder()
    return { ...src, dir, ...svc }
  }

  it('records the exact revision captured by each snapshot', async () => {
    const { store, service } = await connected()
    const revision = store.getState().data.revision
    expect(revision).toBeGreaterThan(0)
    expect(service.getState().status.lastBackup?.revision).toBe(revision)
    expect(service.hasUnbackedChanges()).toBe(false)
  })

  it('detects a change saved in the same millisecond as the snapshot', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-11-01T12:00:00.000Z'))
      const { store, page, service, clock } = await connected()
      const snapshotAt = service.getState().status.lastBackup!.at
      store.renamePage(page.id, 'Edited at the same instant')
      await store.flush()
      expect(store.getState().data.lastChangeAt).toBe(snapshotAt) // identical timestamps
      expect(service.hasUnbackedChanges()).toBe(true)
      clock.advance(service.intervalMs)
      expect(service.isDue()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is not fooled by system clock changes', async () => {
    const { store, page, service, clock } = await connected()
    store.renamePage(page.id, 'Changed')
    await store.flush()
    const at = Date.parse(service.getState().status.lastBackup!.at)
    // Within a session the monotonic clock decides: a wall clock jump does not.
    expect(service.isDue(at + 10 * 24 * 3600 * 1000)).toBe(false)
    expect(service.isDue(at - 10 * 24 * 3600 * 1000)).toBe(false)
    clock.advance(service.intervalMs)
    expect(service.isDue(at - 10 * 24 * 3600 * 1000)).toBe(true)

    // A new session only has wall time; a clock set backwards counts as due.
    const reopened = serviceFor(store, undefined, fakeClock())
    await reopened.service.init()
    expect(reopened.service.isDue(at + 60_000)).toBe(false)
    expect(reopened.service.isDue(at - 3600_000)).toBe(true)
    expect(reopened.service.isDue(at + reopened.service.intervalMs)).toBe(true)
  })

  it('handles changes saved while a backup is being prepared', async () => {
    const { store, page, service, dir, repo } = await connected()
    const original = repo.readAll.bind(repo)
    vi.spyOn(repo, 'readAll').mockImplementationOnce(async () => {
      // Saved before the snapshot's read: included.
      store.renamePage(page.id, 'Included')
      await store.flush()
      const result = await original()
      // Saved after the read, while the ZIP is still being built: not included.
      store.renamePage(page.id, 'Not included')
      await store.flush()
      return result
    })
    const result = await service.backupNow()
    expect(result.ok).toBe(true)
    const archive = await readArchive(dir.files.get((result as { fileName: string }).fileName)!)
    if (!archive.ok) throw new Error(archive.errors.join())
    expect(archive.records.pages.find((p) => p.id === page.id)?.title).toBe('Included')
    // The later change is still pending backup, by revision.
    expect(service.getState().status.lastBackup!.revision).toBe(store.getState().data.revision - 1)
    expect(service.hasUnbackedChanges()).toBe(true)
  })

  it('treats a snapshot recorded without a revision (version 0.1.0) as not covering current data', async () => {
    const { store, service, repo } = await connected()
    const status = service.getState().status
    await repo.setSetting('backupStatus', { ...status, lastBackup: { at: status.lastBackup!.at, fileName: status.lastBackup!.fileName } })
    const reopened = serviceFor(store)
    await reopened.service.init()
    expect(reopened.service.hasUnbackedChanges()).toBe(true)
  })
})

describe('saved folder crash guard', () => {
  it('forgets the saved folder if reading it never finished in this tab', async () => {
    const src = await sampleWorkspace()
    const dir = new FakeDir()
    const first = serviceFor(src.store, dir)
    await first.service.init()
    await first.service.chooseFolder()
    expect(first.service.getState().folderName).toBe('Dropbox Backups')

    let marker = true // as if the previous read crashed the page
    const guarded = new BackupService(src.store, {
      appVersion: 'test',
      folderSupported: true,
      crashGuard: { isSet: () => marker, set: (on) => (marker = on) },
    })
    await guarded.init()
    expect(guarded.getState().folderState).toBe('none')
    expect(guarded.getState().status.lastError?.message).toMatch(/Choose the backup folder again/)
    expect(marker).toBe(false)

    // A normal start afterwards reads settings without the stale handle.
    const normal = new BackupService(src.store, { appVersion: 'test', folderSupported: true, crashGuard: { isSet: () => false, set: () => undefined } })
    await normal.init()
    expect(normal.getState().folderName).toBeNull()
  })
})


describe('trashed pages of deleted sections (version-1 defect)', () => {
  it('keeps the trashed page valid when its section or notebook is deleted, so backups restore', async () => {
    const { store } = await freshStore()
    const a = store.createNotebook('Temp A')
    const b = store.createNotebook('Temp B')
    const inSection = store.createPage({ kind: 'section', sectionId: a.section.id }, 'Old section page')
    const inNotebook = store.createPage({ kind: 'section', sectionId: b.section.id }, 'Old notebook page')
    store.trashPage(inSection.id)
    store.trashPage(inNotebook.id)
    expect(store.deleteSection(a.section.id)).toBe(true)
    expect(store.deleteNotebook(b.notebook.id)).toBe(true)
    for (const id of [inSection.id, inNotebook.id]) {
      expect(store.getState().data.pages[id]).toMatchObject({ location: { kind: 'inbox' }, trashedAt: expect.any(String) })
    }
    const { bytes } = await serviceFor(store).service.createArchive()
    const validated = await readArchive(bytes)
    expect(validated.ok).toBe(true)
    store.restorePage(inSection.id)
    expect(store.getState().data.pages[inSection.id]).toMatchObject({ location: { kind: 'inbox' }, trashedAt: null })
  })

  it('restores an existing version-1 backup that contains the orphaned trashed page', async () => {
    const src = await sampleWorkspace()
    const { records, blobs } = await src.repo.readAll()
    const at = nowIso()
    const orphan = { ...records.pages[0], id: newId(), title: 'Trashed in deleted section', location: { kind: 'section' as const, sectionId: 'deleted-section' }, trashedAt: at }
    const v1 = toStage1Records({ ...records, pages: [...records.pages, orphan] })
    const validated = await readArchive(await buildStage1Archive(v1, blobs))
    if (!validated.ok) throw new Error(validated.errors.join('\n'))
    expect(validated.warnings.join(' ')).toMatch(/deleted section/)
    expect(validated.records.pages.find((p) => p.id === orphan.id)?.location).toEqual({ kind: 'inbox' })

    const clean = await freshStore()
    const target = serviceFor(clean.store)
    await target.service.init()
    await target.service.restore(validated)
    expect(clean.store.getState().data.pages[orphan.id]).toMatchObject({ location: { kind: 'inbox' }, trashedAt: at })
  })

  it('still rejects a live page that points at a missing section', async () => {
    const src = await sampleWorkspace()
    const { records, blobs } = await src.repo.readAll()
    const broken = { ...records, pages: records.pages.map((p) => (p.location.kind === 'section' ? { ...p, location: { kind: 'section' as const, sectionId: 'gone' } } : p)) }
    const result = await readArchive(await buildArchive(broken, blobs, 'test'))
    expect(result).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringMatching(/missing section/)]) })
  })
})


describe('folder backup ownership across asynchronous builds and writes', () => {
  async function connected() {
    const src = await sampleWorkspace()
    await src.store.becomeEditor()
    const dir = new FakeDir()
    const { service } = serviceFor(src.store, dir)
    await service.init()
    await service.chooseFolder()
    // Ten recorded snapshots plus the next one exceed the retention count, so any unexpected pruning is visible.
    await recordedBackups(service, src.store, src.page.id, 9)
    expect([...dir.files.keys()].filter(isSnapshotName)).toHaveLength(10)
    const status = { ...service.getState().status, lastDownloadAt: '2026-11-14T12:00:00.000Z' }
    const takeOver = async () => {
      const other = new WorkspaceStore(src.repo)
      await other.becomeEditor()
      src.store.setReadOnly(true)
      await src.repo.setSetting('backupStatus', status)
    }
    return { ...src, dir, service, status, takeOver }
  }

  it('does not start a folder write or prune after losing editing during archive construction', async () => {
    const { dir, service, takeOver, repo, status } = await connected()
    const before = [...dir.files.entries()]
    const create = service.createArchive.bind(service)
    vi.spyOn(service, 'createArchive').mockImplementationOnce(async () => {
      const archive = await create()
      await takeOver()
      return archive
    })
    expect(await service.backupNow()).toMatchObject({ ok: false, message: expect.stringMatching(/No folder file was written/) })
    expect([...dir.files.entries()]).toEqual(before)
    expect(await repo.getSetting('backupStatus')).toEqual(status)
    expect(service.getState().running).toBeNull()
  })

  it.each([true, false])('keeps a completed snapshot without pruning/status changes after a takeover during the write (notified: %s)', async (notified) => {
    const { dir, service, takeOver, repo, status } = await connected()
    const before = [...dir.files.entries()]
    dir.beforeClose = notified ? takeOver : async () => {
      await new WorkspaceStore(repo).becomeEditor()
      await repo.setSetting('backupStatus', status)
    }
    expect(await service.backupNow()).toMatchObject({ ok: false, message: expect.stringMatching(/complete snapshot was written/) })
    expect([...dir.files.keys()].filter(isSnapshotName)).toHaveLength(before.length + 1)
    for (const [name, bytes] of before) expect(dir.files.get(name)).toEqual(bytes)
    const added = [...dir.files.keys()].filter((name) => !before.some(([old]) => old === name))
    expect(added).toHaveLength(1)
    expect((await readArchive(dir.files.get(added[0])!)).ok).toBe(true)
    expect(await repo.getSetting('backupStatus')).toEqual(status)
    expect(service.getState().running).toBeNull()
  })

  it('does not remove another snapshot after a takeover during an in-progress deletion', async () => {
    const { dir, service, takeOver, repo, status } = await connected()
    const before = [...dir.files.keys()]
    const remove = vi.spyOn(dir, 'removeEntry').mockImplementationOnce(async (name) => {
      dir.files.delete(name)
      await takeOver()
    })
    expect(await service.backupNow()).toMatchObject({ ok: false })
    expect(remove).toHaveBeenCalledTimes(1)
    expect([...dir.files.keys()].filter(isSnapshotName)).toHaveLength(before.length)
    expect(await repo.getSetting('backupStatus')).toEqual(status)
  })

  it('stops removals when editing moves while the retention list is being read', async () => {
    const { dir, service, takeOver, repo, status } = await connected()
    const before = [...dir.files.keys()]
    const keys = dir.keys.bind(dir)
    let lists = 0
    vi.spyOn(dir, 'keys').mockImplementation(async function* () {
      // The first list chooses a unique output name; the second starts retention.
      if (++lists === 2) await takeOver()
      yield* keys()
    })
    expect(await service.backupNow()).toMatchObject({ ok: false, message: expect.stringMatching(/cleanup and backup status updates were stopped/) })
    expect(before.every((name) => dir.files.has(name))).toBe(true)
    expect([...dir.files.keys()].filter(isSnapshotName)).toHaveLength(before.length + 1)
    expect(await repo.getSetting('backupStatus')).toEqual(status)
  })
  // Audit L1: the error path must not store status after a takeover.
  it('a failed flush after a takeover does not overwrite the stored backup status', async () => {
    const { store, dir, service, repo, status, page } = await connected()
    const before = [...dir.files.entries()]
    store.renamePage(page.id, 'Unsaved in the old window')
    // Another window claims storage; this window has not been told yet.
    const other = new WorkspaceStore(repo)
    await other.becomeEditor()
    await repo.setSetting('backupStatus', status)
    const result = await service.backupNow()
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/did not change the backup status/) })
    expect(store.isOwner).toBe(false)
    expect([...dir.files.entries()]).toEqual(before)
    expect(await repo.getSetting('backupStatus')).toEqual(status)
    expect(service.getState().running).toBeNull()
  })

  it.each([
    ['the lock-loss signal arrived', true],
    ['only storage knows about the takeover', false],
  ])('a failed folder write after a takeover does not overwrite the stored backup status (%s)', async (_label, notified) => {
    const { store, dir, service, takeOver, repo, status } = await connected()
    const before = [...dir.files.keys()]
    dir.beforeClose = async () => {
      if (notified) await takeOver()
      else {
        await new WorkspaceStore(repo).becomeEditor()
        await repo.setSetting('backupStatus', status)
      }
      throw new DOMException('disk full', 'QuotaExceededError')
    }
    const result = await service.backupNow()
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/disk is full.*did not change the backup status/) })
    // The simulated lock-loss signal freezes the window; a storage-only takeover is detected by the token check.
    expect(notified ? store.getState().readOnly : !store.isOwner).toBe(true)
    // Nothing was deleted; only the failed attempt's own empty output was added.
    expect(before.every((name) => dir.files.has(name))).toBe(true)
    expect([...dir.files.keys()].filter((name) => !before.includes(name)).map((name) => dir.files.get(name)!.byteLength)).toEqual([0])
    expect(await repo.getSetting('backupStatus')).toEqual(status)
  })

  it('a window that never owned editing does not store status, even from a download or a folder error', async () => {
    const { repo, status } = await connected()
    await repo.setSetting('backupStatus', status)
    const reader = new WorkspaceStore(repo)
    await reader.load()
    reader.revokeOwnership()
    const { service: readerService, downloads } = serviceFor(reader, new FakeDir())
    await readerService.init()
    expect(await readerService.downloadBackup()).toMatchObject({ ok: true })
    expect(downloads).toHaveLength(1)
    expect(readerService.getState().status.lastDownloadAt).not.toBe(status.lastDownloadAt)
    expect(await repo.getSetting('backupStatus')).toEqual(status)
  })

  // Audit L2: a stale in-memory owner flag must not let folder work continue.
  it('refuses the folder write when storage shows a takeover during archive construction that this window was not told about', async () => {
    const { store, dir, service, repo, status } = await connected()
    const before = [...dir.files.entries()]
    const create = service.createArchive.bind(service)
    vi.spyOn(service, 'createArchive').mockImplementationOnce(async () => {
      const archive = await create()
      await new WorkspaceStore(repo).becomeEditor()
      await repo.setSetting('backupStatus', status)
      return archive
    })
    expect(store.getState().readOnly).toBe(false)
    expect(await service.backupNow()).toMatchObject({ ok: false, message: expect.stringMatching(/No folder file was written/) })
    expect(store.isOwner).toBe(false)
    expect(store.getState().readOnly).toBe(true)
    expect([...dir.files.entries()]).toEqual(before)
    expect(await repo.getSetting('backupStatus')).toEqual(status)
  })

  it('stops retention pruning when storage shows a takeover during an in-progress backup', async () => {
    const { store, dir, service, repo, status } = await connected()
    const before = [...dir.files.keys()]
    const remove = vi.spyOn(dir, 'removeEntry').mockImplementationOnce(async (name) => {
      dir.files.delete(name)
      // Claimed in storage only: no lock-loss signal, no read-only flag.
      await new WorkspaceStore(repo).becomeEditor()
      await repo.setSetting('backupStatus', status)
    })
    expect(await service.backupNow()).toMatchObject({ ok: false, message: expect.stringMatching(/complete snapshot was written/) })
    expect(remove).toHaveBeenCalledTimes(1)
    expect(store.isOwner).toBe(false)
    // One new snapshot written, exactly one old one removed before the takeover was seen.
    expect([...dir.files.keys()].filter(isSnapshotName)).toHaveLength(before.length)
    expect(await repo.getSetting('backupStatus')).toEqual(status)
  })

  it('confirmOwnership follows the stored owner token and accepts a workspace with no recorded owner', async () => {
    const { store, repo } = await freshStore()
    expect(await store.confirmOwnership()).toBe(true)
    await store.becomeEditor()
    expect(await store.confirmOwnership()).toBe(true)
    const other = new WorkspaceStore(repo)
    await other.becomeEditor()
    expect(store.isOwner).toBe(true)
    expect(await store.confirmOwnership()).toBe(false)
    expect(store.isOwner).toBe(false)
    expect(store.getState().readOnly).toBe(true)
    expect(await other.confirmOwnership()).toBe(true)
  })
})
