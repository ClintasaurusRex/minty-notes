import { useEffect, useRef, useState } from 'react'
import { chooseReadOnlyFolder, folderBrowseError, FOLDER_ENTRY_LIMIT, listReadOnlyFolder, readFolderPermission, supportsFolderBrowsing, type FolderEntry } from '../platform/folderBrowser'
import './folderBrowser.css'

/** Handles and names exist only in this mounted view, never in a project/backup. */
export function FolderBrowser() {
  const [trail, setTrail] = useState<FileSystemDirectoryHandle[]>([])
  const [entries, setEntries] = useState<FolderEntry[]>([])
  const [message, setMessage] = useState('No folder selected.')
  const [busy, setBusy] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [connected, setConnected] = useState(false)
  const generation = useRef(0)
  const chooseButton = useRef<HTMLButtonElement>(null)
  const refreshButton = useRef<HTMLButtonElement>(null)
  const status = useRef<HTMLParagraphElement>(null)
  /**
   * Where focus goes once the work that disabled the buttons is committed. It is
   * applied in an effect after React has re-enabled the button: a button that is
   * still `disabled` cannot take focus, and an animation frame may run before
   * React commits `busy = false` (an intermittent loss of keyboard focus).
   */
  const [focusRequest, setFocusRequest] = useState<{ target: 'status' | 'refresh' | 'choose' } | null>(null)
  useEffect(() => () => { generation.current++ }, [])
  useEffect(() => {
    if (!focusRequest) return
    const target = { status, refresh: refreshButton, choose: chooseButton }[focusRequest.target].current
    if (target && !(target instanceof HTMLButtonElement && target.disabled)) target.focus()
  }, [focusRequest])
  const supported = supportsFolderBrowsing()

  /**
   * Opening a folder moves focus to the status (it names the new location; the
   * next Tab reaches its entries). Refresh/Reconnect keep focus on that button.
   */
  const load = async (nextTrail: FileSystemDirectoryHandle[], renew = false, focus: 'status' | 'refresh' = 'status') => {
    const token = ++generation.current
    const handle = nextTrail[nextTrail.length - 1]
    setBusy(true)
    setEntries([])
    setTruncated(false)
    setConnected(false)
    setTrail(nextTrail)
    setMessage('Reading folder names…')
    try {
      const permission = await readFolderPermission(handle, renew)
      if (token !== generation.current) return
      if (permission !== 'granted') {
        setMessage(permission === 'denied'
          ? 'Folder permission denied: the browser is not allowing Minty Notes to read this folder. “Reconnect folder browsing” asks the browser again; if it does not show a prompt, choose the folder again.'
          : 'The browser needs your permission again before Minty Notes can read this folder. Select “Reconnect folder browsing” to see the browser’s prompt.')
        return
      }
      const result = await listReadOnlyFolder(handle)
      if (token !== generation.current) return
      setEntries(result.entries)
      setTruncated(result.truncated)
      setConnected(true)
      setMessage(`${handle.name}: ${result.entries.length}${result.truncated ? '+' : ''} entries. Read-only.`)
    } catch (error) {
      if (token === generation.current) setMessage(folderBrowseError(error))
    } finally {
      if (token === generation.current) {
        setBusy(false)
        setFocusRequest({ target: focus })
      }
    }
  }

  const choose = async () => {
    const token = ++generation.current
    setBusy(true)
    // Call the picker before any await: native selection needs a user gesture.
    let opened = false
    try {
      const handle = await chooseReadOnlyFolder()
      if (handle && token === generation.current) {
        opened = true
        await load([handle])
      }
    } catch (error) {
      if (token === generation.current) setMessage(folderBrowseError(error))
    } finally {
      if (token === generation.current) setBusy(false)
      // Cancelled or failed: the button was disabled while the picker was open.
      if (!opened && token === generation.current) setFocusRequest({ target: 'choose' })
    }
  }

  const disconnect = () => {
    generation.current++
    setTrail([])
    setEntries([])
    setTruncated(false)
    setConnected(false)
    setBusy(false)
    setMessage('Minty Notes stopped browsing and forgot this folder. The browser’s own access permission for this site is not changed by this; it normally ends when you close all of this site’s tabs, or you can remove it in the browser’s site settings.')
    setFocusRequest({ target: 'choose' })
  }

  return (
    <section className="folder-browser" aria-labelledby="folder-browser-h" data-testid="folder-browser">
      <h3 id="folder-browser-h">Browse a local folder</h3>
      <p className="muted small">Choose a folder to see its names and open subfolders here. Minty Notes asks the browser for read-only access, lists one level at a time, and never opens, changes, or deletes files. Minty Notes forgets the folder when you leave Files, stop browsing, or reload, and never puts it in backups or project exports. The browser may keep this site’s permission until all of its tabs are closed.</p>
      {!supported ? (
        <p className="muted small">Folder browsing is unavailable in this browser. Use the saved copyable paths and web links above.</p>
      ) : (
        <>
          <div className="btn-row">
            <button type="button" className="btn btn-small" ref={chooseButton} disabled={busy} onClick={() => void choose()}>{trail.length ? 'Choose another folder…' : 'Choose folder to browse…'}</button>
            {trail.length > 0 && <>
              <button type="button" className="btn btn-small" ref={refreshButton} disabled={busy} onClick={() => void load(trail, !connected, 'refresh')}>{connected ? 'Refresh folder' : 'Reconnect folder browsing'}</button>
              <button type="button" className="btn btn-small" onClick={disconnect}>Stop browsing this folder</button>
            </>}
          </div>
          <p className="small" ref={status} tabIndex={-1} role="status" aria-live="polite">{message}</p>
          {trail.length > 0 && <nav aria-label="Folder location" className="btn-row">
            {trail.map((handle, index) => <button type="button" key={index} className="link-btn" disabled={busy || index === trail.length - 1} aria-current={index === trail.length - 1 ? 'location' : undefined} onClick={() => void load(trail.slice(0, index + 1))}>{handle.name}{index < trail.length - 1 ? ' /' : ''}</button>)}
          </nav>}
          {connected && entries.length === 0 && <p className="muted small">This folder is empty.</p>}
          {entries.length > 0 && <ul className="file-list" aria-label="Folder entries">
            {entries.map((entry) => <li key={entry.name} className="folder-entry">
              {entry.kind === 'directory'
                ? <button type="button" className="btn btn-small" disabled={busy} onClick={() => void load([...trail, entry.handle])}>Folder: {entry.name}</button>
                : <span>File: {entry.name}</span>}
            </li>)}
          </ul>}
          {truncated && <p className="small warn-text">Showing the first {FOLDER_ENTRY_LIMIT.toLocaleString()} entries supplied by the browser, sorted with folders first. Use your file manager for the full directory.</p>}
        </>
      )}
    </section>
  )
}
