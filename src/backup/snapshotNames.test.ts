import { afterEach, describe, expect, it } from 'vitest'
import { FolderWriteError, isSnapshotName, listSnapshots, safeguardFileName, snapshotFileName, snapshotTime, writeFolderFile } from './folder'

// Node applies a runtime change of process.env.TZ, so real zone rules (and real
// daylight-saving transitions) are exercised here, not a hand-written model.
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env
const originalTz = env.TZ
function inZone(tz: string): void {
  env.TZ = tz
}
afterEach(() => {
  if (originalTz === undefined) delete env.TZ
  else env.TZ = originalTz
})

const at = (iso: string) => Date.parse(iso)

/** A snapshot name in the pre-0.5.0 UTC format, as older versions wrote it. */
function legacyName(ms: number): string {
  return `minty-notes-backup-${new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}Z.zip`
}

/** Simulated directory handle whose files carry a modification time, as real files do. */
class MemDir {
  files = new Map<string, { bytes: Uint8Array; modified: number | null }>()
  clock = 0
  failWrite: Error | null = null
  async *keys() {
    yield* [...this.files.keys()]
  }
  async removeEntry(name: string) {
    this.files.delete(name)
  }
  add(name: string, modified: number | null) {
    if (this.files.has(name)) throw new Error(`test setup: ${name} exists`)
    this.files.set(name, { bytes: new Uint8Array([1]), modified })
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (!opts?.create) throw new DOMException('missing', 'NotFoundError')
      this.files.set(name, { bytes: new Uint8Array(), modified: this.clock })
    }
    return {
      createWritable: async () => {
        let pending: Uint8Array = new Uint8Array()
        return {
          write: async (b: Uint8Array) => {
            if (this.failWrite) throw this.failWrite
            pending = b
          },
          close: async () => void this.files.set(name, { bytes: pending, modified: this.clock }),
          abort: async () => undefined,
        }
      },
      getFile: async () => {
        const f = this.files.get(name)!
        const blob = new Blob([f.bytes as Uint8Array<ArrayBuffer>])
        return f.modified === null ? blob : Object.assign(blob, { lastModified: f.modified })
      },
    }
  }
  get handle() {
    return this as unknown as FileSystemDirectoryHandle
  }
}

/** Write a snapshot the way the backup service does, with the computer's clock reading `ms`. */
async function backupAt(dir: MemDir, ms: number, trueMs = ms): Promise<string> {
  dir.clock = trueMs
  return (await writeFolderFile(dir.handle, snapshotFileName(new Date(ms)), new Uint8Array([1, 2, 3]))).fileName
}

describe('new snapshot names use local date and 24-hour time without seconds', () => {
  it('formats the examples from the owner request (Tokyo, no daylight saving)', () => {
    inZone('Asia/Tokyo')
    expect(snapshotFileName(new Date(at('2026-11-14T23:00:00Z')))).toBe('minty-notes-backup-20261115-0800.zip')
    expect(snapshotFileName(new Date(at('2026-11-15T04:34:59.999Z')))).toBe('minty-notes-backup-20261115-1334.zip')
    expect(snapshotFileName(new Date(at('2026-11-15T12:45:00Z')))).toBe('minty-notes-backup-20261115-2145.zip')
  })

  it('pads every field with leading zeros, including midnight', () => {
    inZone('UTC')
    expect(snapshotFileName(new Date(at('2026-01-02T03:04:05Z')))).toBe('minty-notes-backup-20260102-0304.zip')
    expect(snapshotFileName(new Date(at('2026-12-31T00:00:00Z')))).toBe('minty-notes-backup-20261231-0000.zip')
    expect(snapshotFileName(new Date(at('2026-09-09T23:59:59Z')))).toBe('minty-notes-backup-20260909-2359.zip')
  })

  it('uses the local calendar date, not the UTC date', () => {
    inZone('America/Los_Angeles')
    // 05:30 UTC on 16 November is 21:30 on 15 November in Los Angeles.
    expect(snapshotFileName(new Date(at('2026-11-16T05:30:00Z')))).toBe('minty-notes-backup-20261115-2130.zip')
  })

  it('leaves the before-restore safety copy name unchanged (UTC, seconds)', () => {
    inZone('Asia/Tokyo')
    expect(safeguardFileName(new Date(at('2026-11-15T04:34:05Z')))).toBe('minty-notes-before-restore-20261115-043405Z.zip')
  })
})

describe('multiple backups within one minute', () => {
  it('adds -2, -3 and never replaces the earlier files', async () => {
    inZone('UTC')
    const dir = new MemDir()
    const t = at('2026-11-15T13:34:00Z')
    const names = [await backupAt(dir, t), await backupAt(dir, t + 20_000), await backupAt(dir, t + 59_000)]
    expect(names).toEqual(['minty-notes-backup-20261115-1334.zip', 'minty-notes-backup-20261115-1334-2.zip', 'minty-notes-backup-20261115-1334-3.zip'])
    expect(names.every(isSnapshotName)).toBe(true)
    expect(dir.files.size).toBe(3)
    expect(await listSnapshots(dir.handle)).toEqual(names)
  })

  it('a failed write in a busy minute deletes nothing and reports the empty file it may leave', async () => {
    inZone('UTC')
    const dir = new MemDir()
    const t = at('2026-11-15T13:34:00Z')
    await backupAt(dir, t)
    await backupAt(dir, t + 1000)
    dir.add(legacyName(t - 3_600_000), 1)
    const before = new Map([...dir.files].map(([n, f]) => [n, f.bytes]))
    dir.failWrite = new DOMException('disk full', 'QuotaExceededError')
    const failure = await backupAt(dir, t + 2000).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(FolderWriteError)
    expect(failure).toMatchObject({ name: 'QuotaExceededError', fileName: 'minty-notes-backup-20261115-1334-3.zip', message: 'disk full' })
    // Every earlier file is untouched; the only change is the empty file the attempt opened.
    for (const [name, bytes] of before) expect(dir.files.get(name)?.bytes).toEqual(bytes)
    expect([...dir.files.keys()].filter((n) => !before.has(n))).toEqual(['minty-notes-backup-20261115-1334-3.zip'])
    expect(dir.files.get('minty-notes-backup-20261115-1334-3.zip')!.bytes.byteLength).toBe(0)
    dir.failWrite = null
    expect(await backupAt(dir, t + 3000)).toBe('minty-notes-backup-20261115-1334-4.zip')
  })
})

describe('old and new names side by side', () => {
  it('recognises both formats with and without collision suffixes, and nothing else', () => {
    for (const name of [
      'minty-notes-backup-20261115-213400Z.zip',
      'minty-notes-backup-20261115-213400Z-2.zip',
      'minty-notes-backup-20261115-2134.zip',
      'minty-notes-backup-20261115-2134-2.zip',
      'minty-notes-backup-20261115-2134-12.zip',
    ]) expect(isSnapshotName(name), name).toBe(true)
    for (const name of [
      'minty-notes-before-restore-20261115-213400Z.zip',
      'minty-project-Lift-Station-20261115-213400Z.zip',
      'minty-notes-backup-20261115-2134Z.zip',
      'minty-notes-backup-20261115-21340.zip',
      'minty-notes-backup-20261115-2134.zip.part',
      'minty-notes-backup-20261115-2134 (1).zip',
    ]) expect(isSnapshotName(name), name).toBe(false)
  })

  it('reads old names as exact UTC moments and new names with local zone rules', () => {
    inZone('America/Los_Angeles')
    expect(snapshotTime('minty-notes-backup-20261115-213400Z.zip')).toEqual({ earliest: at('2026-11-15T21:34:00Z'), latest: at('2026-11-15T21:34:00.999Z'), suffix: 1 })
    // 13:34 PST is 21:34 UTC; seconds are unknown, so the whole minute is covered.
    expect(snapshotTime('minty-notes-backup-20261115-1334-3.zip')).toEqual({ earliest: at('2026-11-15T21:34:00Z'), latest: at('2026-11-15T21:34:59.999Z'), suffix: 3 })
    // Impossible dates are recognised (so never pruned by mistake) but have no time.
    expect(isSnapshotName('minty-notes-backup-20260231-1200.zip')).toBe(true)
    expect(snapshotTime('minty-notes-backup-20260231-1200.zip')).toBeNull()
    expect(snapshotTime('minty-notes-backup-20261115-2460.zip')).toBeNull()
  })

  it('lists mixed names chronologically where alphabetical order is wrong', async () => {
    inZone('America/Los_Angeles')
    const dir = new MemDir()
    // 21:34 UTC (old) is 13:34 local, before the 14:00 local backup, though "2134…" sorts after "1400".
    for (const name of ['minty-notes-backup-20261115-1400-10.zip', 'minty-notes-backup-20261115-1400.zip', 'minty-notes-backup-20261115-213400Z.zip', 'minty-notes-backup-20261115-1400-2.zip']) dir.add(name, null)
    expect(await listSnapshots(dir.handle)).toEqual([
      'minty-notes-backup-20261115-213400Z.zip',
      'minty-notes-backup-20261115-1400.zip',
      'minty-notes-backup-20261115-1400-2.zip',
      'minty-notes-backup-20261115-1400-10.zip',
    ])
  })
})
