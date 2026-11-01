import { useEffect, useState } from 'react'
import { useAppUpdate, useBackupState, useLockState, useServices, useWorkspace } from '../app/context'
import { applyUpdate } from '../platform/serviceWorker'
import { formatBytes, readStorageInfo, requestPersistentStorage, type StorageInfo } from '../platform/storageInfo'
import { fullDateTime, relativeTime } from './format'
import { IconDownload, IconFolder, IconRestore } from './icons'
import { notify } from './notices'
import { RestoreDialog } from './RestoreDialog'

const FOLDER_TEXT: Record<string, string> = {
  unsupported: 'This browser cannot write to a folder. Use “Download backup”. (Folder backups need Chrome or Edge on a computer.)',
  none: 'No backup folder chosen yet.',
  granted: 'Connected.',
  prompt: 'Minty Notes needs your permission again to write to this folder (browsers ask again after a restart).',
  denied: 'Permission to write to this folder was refused.',
  missing: 'The folder could not be found. It may have been moved or deleted.',
}

export function SettingsView() {
  const { backup, store } = useServices()
  const state = useBackupState()
  const lock = useLockState()
  const update = useAppUpdate()
  const readOnly = useWorkspace((s) => s.readOnly)
  const save = useWorkspace((s) => s.save)
  const [storage, setStorage] = useState<StorageInfo | null>(null)
  const [restore, setRestore] = useState<{ source: string; load: () => Promise<Uint8Array> } | null>(null)
  const [snapshots, setSnapshots] = useState<string[] | null>(null)

  useEffect(() => {
    void readStorageInfo().then(setStorage)
  }, [save.lastSavedAt])

  const report = (result: { ok: boolean; message?: string; fileName?: string } | null, success: string) => {
    if (!result) return
    if (result.ok) notify('success', success)
    else notify('error', result.message ?? 'Backup failed.')
  }

  const run = (fn: () => Promise<void>) => () => {
    fn().catch((err: unknown) => notify('error', err instanceof Error ? err.message : String(err)))
  }

  const folderOk = state.folderState === 'granted'

  return (
    <div className="settings">
      <h1>Settings</h1>

      <section className="card" aria-labelledby="backup-h">
        <h2 id="backup-h">Backups</h2>
        <p className="muted">
          Your notes live in this browser on this computer. Backups are complete copies (notes, layout, and images) saved as ZIP files. Keep them in a folder that is itself backed up — for example a Dropbox folder.
        </p>
        <div className="kv">
          <div>
            <span className="k">Backup folder</span>
            <span className="v" data-testid="folder-state">
              {state.folderName ? <strong>{state.folderName}</strong> : null} {FOLDER_TEXT[state.folderState]}
            </span>
          </div>
          <div>
            <span className="k">Last folder backup</span>
            <span className="v" data-testid="last-backup">
              {state.status.lastBackup ? `${fullDateTime(state.status.lastBackup.at)} — ${state.status.lastBackup.fileName}` : 'never'}
            </span>
          </div>
          <div>
            <span className="k">Last download</span>
            <span className="v">{state.status.lastDownloadAt ? `${fullDateTime(state.status.lastDownloadAt)} (the browser cannot confirm the file was kept)` : 'never'}</span>
          </div>
          {state.status.lastError && (
            <div>
              <span className="k">Last problem</span>
              <span className="v error-text" data-testid="backup-error">
                {relativeTime(state.status.lastError.at)}: {state.status.lastError.message}
              </span>
            </div>
          )}
        </div>
        {!readOnly && (
          <div className="btn-row">
            {state.folderState !== 'unsupported' && (
              <button type="button" className="btn" disabled={!!state.running} onClick={run(async () => report(await backup.chooseFolder(), 'Backup folder connected and first backup saved.'))}>
                <IconFolder size={16} /> {state.folderName ? 'Change folder…' : 'Choose backup folder…'}
              </button>
            )}
            {(state.folderState === 'prompt' || state.folderState === 'denied') && (
              <button type="button" className="btn btn-primary" onClick={run(async () => report(await backup.reconnectFolder(), 'Backup folder reconnected.'))}>
                Reconnect folder
              </button>
            )}
            {folderOk && (
              <button type="button" className="btn btn-primary" disabled={!!state.running} onClick={run(async () => report(await backup.backupNow(), 'Backup saved to the folder.'))}>
                {state.running === 'backup' ? 'Backing up…' : 'Back up now'}
              </button>
            )}
            <button type="button" className="btn" disabled={!!state.running} onClick={run(async () => report(await backup.downloadBackup(), 'Backup downloaded.'))}>
              <IconDownload size={16} /> {state.running === 'download' ? 'Preparing…' : 'Download backup'}
            </button>
            {state.folderName && (
              <button type="button" className="btn btn-ghost" onClick={run(() => backup.forgetFolder())}>
                Forget folder
              </button>
            )}
          </div>
        )}
        <p className="muted small">
          While Minty Notes is open and there are changes, a new snapshot is written to the folder every {Math.round(backup.intervalMs / 60000)} minutes. The newest {backup.keep} snapshots are kept; an older one is removed only after a new snapshot has been written and checked. Nothing is backed up while the app is closed — when you reopen it, a due backup runs if folder access is still allowed.
        </p>
      </section>

      <section className="card" aria-labelledby="restore-h">
        <h2 id="restore-h">Restore</h2>
        <p className="muted">A backup is checked completely before anything changes. Restoring replaces this workspace; the current one is saved first as a safety copy.</p>
        {readOnly ? (
          <p className="muted">Restore is available in the window that is editing.</p>
        ) : (
          <div className="btn-row">
            <label className="btn">
              <IconRestore size={16} /> Restore from a file…
              <input
                type="file"
                accept=".zip,application/zip"
                hidden
                data-testid="restore-file"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (file) setRestore({ source: file.name, load: async () => new Uint8Array(await file.arrayBuffer()) })
                }}
              />
            </label>
            {folderOk && (
              <button type="button" className="btn" onClick={run(async () => setSnapshots(await backup.listFolderSnapshots()))}>
                Restore from backup folder…
              </button>
            )}
          </div>
        )}
        {snapshots && (
          <div className="snapshot-list">
            {snapshots.length === 0 ? (
              <p className="muted">No Minty Notes snapshots in the folder.</p>
            ) : (
              <ul>
                {snapshots.map((name) => (
                  <li key={name}>
                    <span>{name}</span>
                    <button type="button" className="btn btn-small" onClick={() => setRestore({ source: name, load: () => backup.readFolderSnapshot(name) })}>
                      Restore…
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {state.safeguard && (
          <div className="callout">
            <p>
              Safety copy of the workspace from before the last restore: {fullDateTime(state.safeguard.createdAt)} ({formatBytes(state.safeguard.size)})
              {state.safeguard.folderFileName ? `, also saved in the backup folder as ${state.safeguard.folderFileName}` : ''}.
            </p>
            <div className="btn-row">
              <button type="button" className="btn btn-small" onClick={run(() => backup.downloadSafeguard())}>
                Download safety copy
              </button>
              <button type="button" className="btn btn-small btn-ghost" onClick={run(() => backup.discardSafeguard())}>
                Discard it
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="storage-h">
        <h2 id="storage-h">Storage on this computer</h2>
        <div className="kv">
          <div>
            <span className="k">Last saved</span>
            <span className="v">{save.lastSavedAt ? fullDateTime(save.lastSavedAt) : 'no changes saved in this session'}</span>
          </div>
          <div>
            <span className="k">Persistent storage</span>
            <span className="v" data-testid="persist-state">
              {storage?.persisted === true
                ? 'Granted — the browser will not clear Minty Notes data to free space.'
                : storage?.persisted === false
                  ? 'Not granted — under severe disk pressure the browser could clear site data. Keep regular backups.'
                  : 'Unknown in this browser.'}
            </span>
          </div>
          <div>
            <span className="k">Used</span>
            <span className="v">
              {formatBytes(storage?.usage)} of about {formatBytes(storage?.quota)} available to this site
            </span>
          </div>
        </div>
        {storage?.persisted === false && (
          <button type="button" className="btn btn-small" onClick={run(async () => {
            const granted = await requestPersistentStorage()
            setStorage(await readStorageInfo())
            notify(granted ? 'success' : 'info', granted ? 'Persistent storage granted.' : 'The browser did not grant persistent storage. Installing the app or using it regularly can change this.')
          })}>
            Ask again
          </button>
        )}
      </section>

      <section className="card" aria-labelledby="app-h">
        <h2 id="app-h">App</h2>
        <div className="kv">
          <div>
            <span className="k">Version</span>
            <span className="v">{__APP_VERSION__}</span>
          </div>
          <div>
            <span className="k">Offline use</span>
            <span className="v" data-testid="offline-state">
              {!update.supported ? 'Not available in this build (development server).' : update.offlineReady ? 'Ready — the app opens without a connection.' : update.error ? `Not ready: ${update.error}` : 'Preparing…'}
            </span>
          </div>
          <div>
            <span className="k">This window</span>
            <span className="v">
              {lock === 'editor' ? 'Editing (other windows open read-only).' : lock === 'unsupported' ? 'Editing (this browser cannot coordinate windows — avoid editing in two windows).' : lock === 'read-only' ? 'Read-only: another window is editing.' : 'Connecting…'}
            </span>
          </div>
        </div>
        {update.updateReady && (
          <button type="button" className="btn btn-primary" onClick={run(async () => {
            if (!(await applyUpdate(() => store.flush()))) notify('error', 'Changes could not be saved, so the update was postponed.')
          })}>
            Save and update now
          </button>
        )}
      </section>

      <section className="card" aria-labelledby="keys-h">
        <h2 id="keys-h">Keyboard</h2>
        <dl className="keys">
          <dt>Alt+N</dt>
          <dd>New quick note in the Inbox</dd>
          <dt>Ctrl+V</dt>
          <dd>Paste a screenshot as an image (or text as a new text box)</dd>
          <dt>Ctrl+Z / Ctrl+Shift+Z</dt>
          <dd>Undo / redo (inside text: text undo)</dd>
          <dt>Esc</dt>
          <dd>Leave the text and select its box; Esc again deselects</dd>
          <dt>Tab</dt>
          <dd>Move between objects on the page</dd>
          <dt>Arrows / Shift+Arrows</dt>
          <dd>Move the selected object 1 px / 10 px</dd>
          <dt>Alt+Arrows</dt>
          <dd>Resize the selected object</dd>
          <dt>Enter</dt>
          <dd>Edit the selected text box</dd>
          <dt>Ctrl+D / Delete</dt>
          <dd>Duplicate / delete the selected object</dd>
        </dl>
      </section>

      {restore && <RestoreDialog source={restore.source} load={restore.load} onClose={() => setRestore(null)} />}
    </div>
  )
}
