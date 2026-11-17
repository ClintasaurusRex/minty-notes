import { afterEach, describe, expect, it, vi } from 'vitest'
import { freshStore } from '../test/fixtures'
import { WorkspaceStore } from '../store/workspaceStore'
import { readArchive, sha256Hex } from './archive'
import { BackupService } from './backupService'
import { FolderWriteError, isSnapshotName, pruneSnapshots, writeFolderFile, type LedgerEntry } from './folder'

// Regression tests for the Stage 5 backup-safety audit (H1, H2, M1, M2).
// The rule under test: a backup is deleted only when it is provably the file
// Minty Notes wrote, and `keep` provably complete backups were recorded after it.
// Directory handles are simulated; Chrome's real folder, permission and disk
// behaviour are not exercised here.

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env
const originalTz = env.TZ
afterEach(() => {
  vi.useRealTimers()
  if (originalTz === undefined) delete env.TZ
  else env.TZ = originalTz
})

/** Simulated folder. Files carry a modification time that tests may drop or rewrite. */
class Folder {
  files = new Map<string, { bytes: Uint8Array; modified: number | undefined }>()
  removed: string[] = []
  // Test hooks live in a private field: the service stores the handle in IndexedDB,
  // and functions cannot be structured-cloned (private fields are not cloned).
  #hooks = {
    onLookup: null as ((name: string, create: boolean) => void) | null,
    beforeClose: null as ((name: string) => void) | null,
    failClose: null as Error | null,
    mtime: (() => Date.now()) as () => number | undefined,
  }
  /** Called at the start of every handle lookup (lets a test act "between" two operations). */
  get onLookup() { return this.#hooks.onLookup }
  set onLookup(v) { this.#hooks.onLookup = v }
  get beforeClose() { return this.#hooks.beforeClose }
  set beforeClose(v) { this.#hooks.beforeClose = v }
  get failClose() { return this.#hooks.failClose }
  set failClose(v) { this.#hooks.failClose = v }
  get mtime() { return this.#hooks.mtime }
  set mtime(v) { this.#hooks.mtime = v }
  async *keys() {
    yield* [...this.files.keys()]
  }
  async removeEntry(name: string) {
    if (!this.files.has(name)) throw new DOMException('missing', 'NotFoundError')
    this.files.delete(name)
    this.removed.push(name)
  }
  put(name: string, bytes: Uint8Array) {
    this.files.set(name, { bytes, modified: this.mtime() })
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    this.onLookup?.(name, !!opts?.create)
    if (!this.files.has(name)) {
      if (!opts?.create) throw new DOMException('missing', 'NotFoundError')
      this.put(name, new Uint8Array())
    }
    return {
      createWritable: async () => {
        let pending: Uint8Array = new Uint8Array()
        return {
          write: async (b: Uint8Array) => void (pending = b),
          close: async () => {
            this.beforeClose?.(name)
            if (this.failClose) throw this.failClose
            this.put(name, pending)
          },
          abort: async () => undefined,
        }
      },
      getFile: async () => {
        const f = this.files.get(name)
        if (!f) throw new DOMException('missing', 'NotFoundError')
        const blob = new Blob([f.bytes as Uint8Array<ArrayBuffer>])
        return f.modified === undefined ? blob : Object.assign(blob, { lastModified: f.modified })
      },
    }
  }
  async queryPermission() {
    return 'granted' as PermissionState
  }
  snapshots() {
    return [...this.files.keys()].filter(isSnapshotName)
  }
}

async function setup(keep = 10) {
  const { store, repo } = await freshStore()
  await store.becomeEditor()
  const page = store.createPage({ kind: 'inbox' })
  await store.flush()
  const dir = new Folder()
  const service = new BackupService(store, { appVersion: 'test', folderSupported: true, keep, pickFolder: async () => dir as unknown as FileSystemDirectoryHandle, download: () => undefined })
  await service.init()
  let n = 0
  /** Save a change, then back up; returns the new file's name. Order of calls = true creation order. */
  const backup = async () => {
    store.renamePage(page.id, `Change ${++n}`)
    await store.flush()
    const result = n === 1 ? await service.chooseFolder() : await service.backupNow()
    if (!result?.ok) throw new Error(result?.message)
    return result.fileName
  }
  return { store, repo, page, dir, service, backup }
}

/** The central guarantee: the `keep` most recently created backups are all still present and restorable. */
async function expectNewestKept(dir: Folder, created: string[], keep = 10) {
  for (const name of created.slice(-keep)) {
    expect(dir.files.has(name), `${name} must be kept`).toBe(true)
    expect((await readArchive(dir.files.get(name)!.bytes)).ok, `${name} must restore`).toBe(true)
  }
}

describe('H1: order never comes from clocks, names, or modification times', () => {
  it('clock rolled back one day and then corrected: the really second-newest backup survives', async () => {
    env.TZ = 'UTC'
    vi.useFakeTimers({ toFake: ['Date'] })
    const { dir, backup, service } = await setup()
    const created: string[] = []
    // Ten backups on November 15 (names 20261115-…).
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(Date.UTC(2026, 10, 15, 8 + i))
      created.push(await backup())
    }
    // The clock jumps back to November 14; a new backup gets an older-looking name and mtime.
    vi.setSystemTime(Date.UTC(2026, 10, 14, 12))
    created.push(await backup())
    expect(created.at(-1)).toBe('minty-notes-backup-20261114-1200.zip')
    // The clock is corrected; another backup.
    vi.setSystemTime(Date.UTC(2026, 10, 15, 20))
    created.push(await backup())
    await expectNewestKept(dir, created)
    // Exactly the two genuinely oldest were removed, though the Nov 14 file looks oldest by name and time.
    expect(dir.removed).toEqual(created.slice(0, 2))
    expect(dir.files.has('minty-notes-backup-20261114-1200.zip')).toBe(true)
    expect(service.getState().status.cleanupWarning).toBeNull()
    // It is removed only once ten backups were genuinely created after it (one already was).
    for (let i = 0; i < 8; i++) {
      vi.setSystemTime(Date.UTC(2026, 10, 15, 21, i))
      created.push(await backup())
      expect(dir.files.has('minty-notes-backup-20261114-1200.zip')).toBe(true)
    }
    vi.setSystemTime(Date.UTC(2026, 10, 15, 22))
    created.push(await backup())
    expect(dir.files.has('minty-notes-backup-20261114-1200.zip')).toBe(false)
    await expectNewestKept(dir, created)
  })

  const backwards = (): (() => number) => {
    let t = Date.UTC(2030, 0, 1)
    return () => (t -= 60_000)
  }
  it.each<[string, () => number | undefined]>([
    ['missing', () => undefined],
    ['rewritten to one moment (a copy or sync)', () => Date.UTC(2020, 0, 1)],
    ['running backwards', backwards()],
  ])('time-zone changes with %s modification times keep the newest 10', async (_label, mtime) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { dir, backup } = await setup()
    dir.mtime = mtime
    const created: string[] = []
    // Travel east then west across zones, an hour apart in real time; local names jump around.
    const zones = ['America/Los_Angeles', 'Asia/Tokyo', 'Europe/Berlin', 'Pacific/Auckland', 'America/New_York', 'UTC', 'Pacific/Honolulu']
    for (let i = 0; i < 21; i++) {
      env.TZ = zones[i % zones.length]
      vi.setSystemTime(Date.UTC(2026, 10, 15, 0) + i * 3_600_000)
      created.push(await backup())
      await expectNewestKept(dir, created)
    }
    expect(dir.snapshots()).toHaveLength(10)
    expect(dir.removed).toEqual(created.slice(0, 11))
  })

  it('same-minute bursts are ordered by recording, not by -n suffix (a freed -2 can be reused)', async () => {
    env.TZ = 'UTC'
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 10, 15, 13, 34))
    const { dir, backup } = await setup(3)
    const created = [await backup(), await backup(), await backup()]
    expect(created).toEqual(['minty-notes-backup-20261115-1334.zip', 'minty-notes-backup-20261115-1334-2.zip', 'minty-notes-backup-20261115-1334-3.zip'])
    created.push(await backup()) // removes the oldest, the unsuffixed name
    expect(dir.removed).toEqual(['minty-notes-backup-20261115-1334.zip'])
    created.push(await backup()) // reuses the freed unsuffixed name, yet it is the newest
    expect(created.at(-1)).toBe('minty-notes-backup-20261115-1334.zip')
    expect(dir.removed).toEqual(['minty-notes-backup-20261115-1334.zip', 'minty-notes-backup-20261115-1334-2.zip'])
    await expectNewestKept(dir, created, 3)
  })
})

describe('H2: only verified, complete backups count as replacements', () => {
  it('nine corrupt, empty, or truncated snapshot-named files never justify deleting a working backup', async () => {
    env.TZ = 'UTC'
    vi.useFakeTimers({ toFake: ['Date'] })
    const { dir, backup, service } = await setup()
    vi.setSystemTime(Date.UTC(2026, 10, 15, 8))
    const working = await backup()
    const workingBytes = dir.files.get(working)!.bytes
    // Interrupted writes, failed cleanups, junk: valid-looking names, clearly newer by name and mtime.
    const junk = [new Uint8Array(), new Uint8Array(4096), workingBytes.subarray(0, workingBytes.byteLength - 1), new Uint8Array([0x50, 0x4b, 3, 4])]
    for (let i = 0; i < 9; i++) {
      vi.setSystemTime(Date.UTC(2026, 10, 15, 9 + i))
      dir.put(`minty-notes-backup-20261115-${String(9 + i).padStart(2, '0')}00.zip`, junk[i] ?? new Uint8Array(workingBytes.byteLength).fill(i))
    }
    vi.setSystemTime(Date.UTC(2026, 10, 15, 20))
    const latest = await backup()
    expect(dir.removed).toEqual([])
    expect(dir.files.get(working)!.bytes).toBe(workingBytes)
    expect((await readArchive(dir.files.get(working)!.bytes)).ok).toBe(true)
    expect(dir.files.has(latest)).toBe(true)
    expect(service.getState().status.cleanupWarning?.message).toMatch(/holds 11 snapshots.*9 were not written and verified/)
  })

  it('recorded backups that were later damaged (even with the same size) stop counting and are never deleted', async () => {
    env.TZ = 'UTC'
    vi.useFakeTimers({ toFake: ['Date'] })
    const { dir, backup, service } = await setup()
    const created: string[] = []
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(Date.UTC(2026, 10, 15, 8 + i))
      created.push(await backup())
    }
    vi.setSystemTime(Date.UTC(2026, 10, 15, 20))
    const oldest = created[0]
    const oldestBytes = dir.files.get(oldest)!.bytes
    // Nine of the newer recorded backups are overwritten in place (same size, other bytes).
    for (const name of created.slice(1)) {
      const bytes = new Uint8Array(dir.files.get(name)!.bytes)
      bytes[bytes.length - 1] ^= 0xff
      dir.put(name, bytes)
    }
    created.push(await backup())
    // Only one verified backup (the new one) is newer than `oldest`: it must stay.
    expect(dir.removed).toEqual([])
    expect(dir.files.get(oldest)!.bytes).toBe(oldestBytes)
    expect(service.getState().status.cleanupWarning?.message).toMatch(/9 have changed or become unreadable.*only 2 verified backups/)
  })

  it('a damaged old backup is not deleted even when ten verified ones are newer (not provably its own output)', async () => {
    env.TZ = 'UTC'
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 10, 15, 6))
    const { dir, backup } = await setup()
    const first = await backup()
    const altered = new Uint8Array(dir.files.get(first)!.bytes)
    altered[10] ^= 1
    dir.put(first, altered)
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(Date.UTC(2026, 10, 15, 8 + i))
      await backup()
    }
    expect(dir.removed).toEqual([])
    expect(dir.files.get(first)!.bytes).toBe(altered)
  })

  it('a backup that fails its own archive check is never written or recorded', async () => {
    const { dir, service, store, repo, page } = await setup()
    const create = service.createArchive.bind(service)
    vi.spyOn(service, 'createArchive').mockImplementationOnce(async () => ({ ...(await create()), bytes: new Uint8Array([0x50, 0x4b, 5, 6, 0, 0]) }))
    store.renamePage(page.id, 'x')
    await store.flush()
    expect(await service.chooseFolder()).toMatchObject({ ok: false, message: expect.stringMatching(/failed its own check, so it was not written/) })
    expect(dir.files.size).toBe(0)
    expect(await repo.getSetting('backupLedger')).toBeUndefined()
  })
})

describe('M1: name collisions and failure cleanup', () => {
  it('a file created at the chosen name after the folder was listed is never overwritten', async () => {
    env.TZ = 'UTC'
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 10, 15, 13, 34))
    const dir = new Folder()
    const theirs = new Uint8Array([9, 9, 9])
    // Another program creates exactly our chosen name between our listing and our create.
    dir.onLookup = (name, create) => {
      if (create && name === 'minty-notes-backup-20261115-1334.zip' && !dir.files.has(name)) dir.put(name, theirs)
    }
    const written = await writeFolderFile(dir as unknown as FileSystemDirectoryHandle, 'minty-notes-backup-20261115-1334.zip', new Uint8Array([1, 2, 3]))
    expect(written.fileName).toBe('minty-notes-backup-20261115-1334-2.zip')
    expect(dir.files.get('minty-notes-backup-20261115-1334.zip')!.bytes).toBe(theirs)
    expect(dir.files.get(written.fileName)!.bytes).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('another writer replacing our output during the write is detected; nothing is recorded or deleted', async () => {
    env.TZ = 'UTC'
    const { dir, service, store, page, repo } = await setup()
    const theirs = new Uint8Array([7, 7, 7, 7])
    dir.beforeClose = (name) => {
      dir.beforeClose = null
      queueMicrotask(() => dir.put(name, theirs)) // their write lands right after our close
    }
    store.renamePage(page.id, 'x')
    await store.flush()
    const result = await service.chooseFolder()
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/could not be confirmed as this backup\. Minty Notes did not delete it/) })
    const [name] = dir.snapshots()
    expect(dir.files.get(name)!.bytes).toBe(theirs)
    expect(dir.removed).toEqual([])
    expect(await repo.getSetting('backupLedger')).toBeUndefined()
  })

  it('a failed write leaves its incomplete file in place; it never counts as a backup and is never pruned', async () => {
    env.TZ = 'UTC'
    const { dir, backup, service } = await setup()
    const created = [await backup()]
    dir.failClose = new DOMException('disk full', 'QuotaExceededError')
    const failed = await service.backupNow()
    expect(failed).toMatchObject({ ok: false, message: expect.stringMatching(/disk is full.*could not be confirmed as this backup/) })
    const incomplete = dir.snapshots().find((n) => !created.includes(n))!
    expect(dir.files.get(incomplete)!.bytes.byteLength).toBe(0)
    // Someone else's bytes arriving at that name are equally safe: failure cleanup deletes nothing.
    dir.failClose = null
    for (let i = 0; i < 14; i++) created.push(await backup())
    expect(dir.files.has(incomplete)).toBe(true)
    expect(dir.removed).not.toContain(incomplete)
    await expectNewestKept(dir, created)
    expect(dir.snapshots()).toHaveLength(11)
    expect(service.getState().status.cleanupWarning?.message).toMatch(/holds 11 snapshots.*1 was not written and verified.*interrupted backup/)
  })

  it('failure cleanup never removes a file another program wrote at our name during a failed write', async () => {
    const dir = new Folder()
    const theirs = new Uint8Array([5, 5, 5])
    dir.beforeClose = (name) => dir.put(name, theirs)
    dir.failClose = new DOMException('disk full', 'QuotaExceededError')
    const error = await writeFolderFile(dir as unknown as FileSystemDirectoryHandle, 'minty-notes-backup-20261115-1334.zip', new Uint8Array([1])).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FolderWriteError)
    expect(dir.removed).toEqual([])
    expect(dir.files.get('minty-notes-backup-20261115-1334.zip')!.bytes).toBe(theirs)
  })
})

describe('retention when the folder changes during cleanup', () => {
  async function recorded(count: number) {
    const dir = new Folder()
    const ledger: LedgerEntry[] = []
    for (let i = 0; i < count; i++) {
      const fileName = `minty-notes-backup-20261115-1334${i ? `-${i + 1}` : ''}.zip`
      const bytes = new Uint8Array([0x50, 0x4b, i])
      dir.put(fileName, bytes)
      ledger.push({ seq: i + 1, fileName, size: bytes.byteLength, sha256: await sha256Hex(bytes), at: '', revision: i })
    }
    return { dir, ledger, handle: dir as unknown as FileSystemDirectoryHandle }
  }

  it('a candidate replaced after the retention list was read is not deleted', async () => {
    const { dir, ledger, handle } = await recorded(12)
    const victim = ledger[0].fileName
    let lookups = 0
    dir.onLookup = (name) => {
      // The kept ten were verified; now, just before the candidate's own check, it is replaced.
      if (name === victim && ++lookups === 1) dir.put(victim, new Uint8Array([0x50, 0x4b, 99]))
    }
    const report = await pruneSnapshots(handle, 10, ledger, ledger.at(-1)!.fileName)
    expect(report.removed).toEqual([ledger[1].fileName])
    expect(report.unverified).toEqual([victim])
    expect(dir.files.get(victim)!.bytes).toEqual(new Uint8Array([0x50, 0x4b, 99]))
  })

  it('a kept replacement deleted or rewritten during cleanup stops all removals', async () => {
    for (const change of ['delete', 'rewrite'] as const) {
      const { dir, ledger, handle } = await recorded(12)
      const keptName = ledger[5].fileName
      let lookups = 0
      dir.onLookup = (name) => {
        if (name !== keptName || ++lookups !== 2) return // 1st lookup verifies it; the 2nd is the pre-removal re-check
        if (change === 'delete') dir.files.delete(keptName)
        else dir.files.set(keptName, { bytes: new Uint8Array([0x50, 0x4b, 5, 0]), modified: Date.now() + 1 })
      }
      const report = await pruneSnapshots(handle, 10, ledger, ledger.at(-1)!.fileName)
      expect(report.removed, change).toEqual([])
      expect(report.stopped, change).toBe(true)
      expect(dir.files.has(ledger[0].fileName) && dir.files.has(ledger[1].fileName), change).toBe(true)
    }
  })

  it('a takeover recorded in storage before the ledger update leaves the snapshot unrecorded, so no window ever deletes it', async () => {
    env.TZ = 'UTC'
    const { dir, backup, service, repo, store } = await setup()
    const created: string[] = []
    for (let i = 0; i < 10; i++) created.push(await backup())
    // Another window claims editing at the moment our write closes.
    dir.beforeClose = () => {
      dir.beforeClose = null
      void new WorkspaceStore(repo).becomeEditor()
    }
    store.renamePage(store.getState().data.pages[Object.keys(store.getState().data.pages)[0]].id, 'late')
    await store.flush()
    const result = await service.backupNow()
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/complete snapshot was written/) })
    const orphan = dir.snapshots().find((n) => !created.includes(n))!
    const ledger = await repo.getSetting<{ entries: LedgerEntry[] }>('backupLedger')
    expect(ledger?.entries.map((e) => e.fileName)).not.toContain(orphan)
    expect(dir.removed).toEqual([])
  })
})

describe('M2: future-dated files no longer suspend cleanup, and are reported', () => {
  it('a future-dated foreign file is kept, cleanup of recorded backups continues, and a warning names the cause', async () => {
    env.TZ = 'UTC'
    const { dir, backup, service, repo } = await setup()
    dir.put('minty-notes-backup-20991231-2359.zip', new Uint8Array([0x50, 0x4b, 3, 4]))
    const created: string[] = []
    for (let i = 0; i < 15; i++) created.push(await backup())
    await expectNewestKept(dir, created)
    expect(dir.removed).toEqual(created.slice(0, 5))
    expect(dir.files.has('minty-notes-backup-20991231-2359.zip')).toBe(true)
    const warning = service.getState().status.cleanupWarning
    expect(warning?.message).toMatch(/holds 11 snapshots, more than the 10 Minty Notes keeps.*1 was not written and verified/)
    expect((await repo.getSetting<{ cleanupWarning: unknown }>('backupStatus'))?.cleanupWarning).toEqual(warning)
    // Once the user deletes it, the warning clears with the next backup.
    dir.files.delete('minty-notes-backup-20991231-2359.zip')
    await backup()
    expect(service.getState().status.cleanupWarning).toBeNull()
  })

  it('a backup written while the clock was years ahead is pruned in turn once ten later backups exist', async () => {
    env.TZ = 'UTC'
    vi.useFakeTimers({ toFake: ['Date'] })
    const { dir, backup, service } = await setup()
    vi.setSystemTime(Date.UTC(2099, 0, 1))
    const future = await backup()
    vi.setSystemTime(Date.UTC(2026, 10, 15))
    const created = [future]
    for (let i = 0; i < 10; i++) created.push(await backup())
    expect(dir.removed).toEqual([future])
    expect(dir.snapshots()).toHaveLength(10)
    expect(service.getState().status.cleanupWarning).toBeNull()
    await expectNewestKept(dir, created)
  })
})

describe('ledger updates are fenced by the editor-owner token', () => {
  it('a window that lost editing cannot record or forget ledger entries, and a refusal writes nothing', async () => {
    const { store, repo } = await freshStore()
    await store.becomeEditor()
    await store.updateSettingAsOwner<{ n: number }>('backupLedger', () => ({ n: 1 }))
    const other = new WorkspaceStore(repo)
    await other.becomeEditor()
    await expect(store.updateSettingAsOwner<{ n: number }>('backupLedger', () => ({ n: 2 }))).rejects.toMatchObject({ name: 'OwnershipError' })
    expect(store.isOwner).toBe(false)
    expect(await repo.getSetting('backupLedger')).toEqual({ n: 1 })
    expect(await other.updateSettingAsOwner<{ n: number }>('backupLedger', (c) => ({ n: (c?.n ?? 0) + 10 }))).toEqual({ n: 11 })
    // A throwing update aborts the transaction.
    await expect(other.updateSettingAsOwner('backupLedger', () => { throw new Error('bad') })).rejects.toThrow('bad')
    expect(await repo.getSetting('backupLedger')).toEqual({ n: 11 })
  })
})
