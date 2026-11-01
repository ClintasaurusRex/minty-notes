import { strToU8, zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { docFromPlainText } from '../domain/richtext'
import { newId, nowIso, type ImageObject, type TextObject } from '../domain/types'
import { freshStore, PNG_1x1 } from '../test/fixtures'
import { buildArchive, readArchive, sha256Hex } from './archive'
import { BackupService } from './backupService'
import { isSnapshotName, snapshotFileName } from './folder'

/** Simulated directory handle. It exercises our logic, not Chrome's real permission UI. */
class FakeDir {
  name = 'Dropbox Backups'
  files = new Map<string, Uint8Array>()
  permission: PermissionState = 'granted'
  requestResult: PermissionState = 'granted'
  failWrite: Error | null = null
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
            this.files.set(name, pending ?? new Uint8Array())
          },
          abort: async () => undefined,
        }
      },
      getFile: async () => new Blob([this.files.get(name)! as Uint8Array<ArrayBuffer>]),
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
    expect(validated.summary.counts).toEqual({ notebooks: 1, sections: 1, pages: 2, objects: 2, attachments: 1 })

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

  it('ignores unexpected and unsafe archive entries with a warning', async () => {
    const { records, blobs } = await validArchiveFiles()
    const { unzipSync } = await import('fflate')
    const files = unzipSync(await buildArchive(records, blobs, 'test'))
    const result = await readArchive(zipSync({ ...files, '../evil.txt': strToU8('x'), 'extra.bin': strToU8('y') }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.warnings.join(' ')).toMatch(/unsafe.*evil|evil.*unsafe|unexpected/)
  })
})

describe('backup folder snapshots (simulated directory handle)', () => {
  it('writes a verified snapshot and keeps only the newest 10', async () => {
    const src = await sampleWorkspace()
    const dir = new FakeDir()
    for (let i = 0; i < 12; i++) dir.files.set(snapshotFileName(new Date(Date.UTC(2026, 0, 1, 0, 0, i))), new Uint8Array([i]))
    dir.files.set('notes.txt', new Uint8Array([1]))
    const { service } = serviceFor(src.store, dir)
    await service.init()
    const result = await service.chooseFolder()
    expect(result).toMatchObject({ ok: true })
    const snapshots = [...dir.files.keys()].filter(isSnapshotName).sort()
    expect(snapshots).toHaveLength(10)
    expect(snapshots.at(-1)).toBe((result as { fileName: string }).fileName)
    // Unrelated files in the folder are never touched.
    expect(dir.files.has('notes.txt')).toBe(true)
    const restored = await readArchive(dir.files.get(snapshots.at(-1)!)!)
    expect(restored.ok).toBe(true)
    expect(service.getState().status.lastBackup?.fileName).toBe(snapshots.at(-1))
  })

  it('does not prune or report success when the write fails', async () => {
    const src = await sampleWorkspace()
    const dir = new FakeDir()
    for (let i = 0; i < 10; i++) dir.files.set(snapshotFileName(new Date(Date.UTC(2026, 0, 1, 0, 0, i))), new Uint8Array([i]))
    const before = [...dir.files.keys()].sort()
    dir.failWrite = new DOMException('disk full', 'QuotaExceededError')
    const { service } = serviceFor(src.store, dir)
    await service.init()
    const result = await service.chooseFolder()
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/disk is full/) })
    expect([...dir.files.keys()].sort()).toEqual(before)
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
    const v1 = { ...records, pages: [...records.pages, orphan] }
    const validated = await readArchive(await buildArchive(v1, blobs, '0.1.0'))
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
