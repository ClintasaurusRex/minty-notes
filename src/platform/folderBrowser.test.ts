import { afterEach, describe, expect, it, vi } from 'vitest'
import { chooseReadOnlyFolder, FOLDER_ENTRY_LIMIT, folderBrowseError, listReadOnlyFolder, readFolderPermission, supportsFolderBrowsing } from './folderBrowser'

afterEach(() => vi.unstubAllGlobals())

describe('read-only folder browsing (simulated handles)', () => {
  it('detects support and asks only for read selection; cancellation is harmless', async () => {
    expect(supportsFolderBrowsing()).toBe(false)
    const handle = { kind: 'directory', name: 'Job folder' }
    const picker = vi.fn().mockResolvedValue(handle)
    vi.stubGlobal('window', { showDirectoryPicker: picker })
    expect(supportsFolderBrowsing()).toBe(true)
    expect(await chooseReadOnlyFolder()).toBe(handle)
    expect(picker).toHaveBeenCalledWith({ id: 'minty-notes-browse', mode: 'read' })
    picker.mockRejectedValue(new DOMException('cancelled', 'AbortError'))
    expect(await chooseReadOnlyFolder()).toBeNull()
  })

  it('does not renew permissions until explicitly asked and always requests read only', async () => {
    const queryPermission = vi.fn().mockResolvedValue('prompt')
    const requestPermission = vi.fn().mockResolvedValue('granted')
    const handle = { queryPermission, requestPermission } as unknown as FileSystemDirectoryHandle
    expect(await readFolderPermission(handle)).toBe('prompt')
    expect(requestPermission).not.toHaveBeenCalled()
    expect(await readFolderPermission(handle, true)).toBe('granted')
    expect(queryPermission).toHaveBeenCalledWith({ mode: 'read' })
    expect(requestPermission).toHaveBeenCalledWith({ mode: 'read' })
  })

  it('lists one level without reading file bytes or inspecting child directories', async () => {
    const getFile = vi.fn(() => { throw new Error('must not read content') })
    const childValues = vi.fn(() => { throw new Error('must not crawl') })
    const child = { name: 'Drawings', kind: 'directory', values: childValues }
    const root = { async *values() { yield { name: 'PLC.ACD', kind: 'file', getFile }; yield child; yield { name: 'A.txt', kind: 'file', getFile } } } as unknown as FileSystemDirectoryHandle
    const result = await listReadOnlyFolder(root)
    expect(result.entries.map((entry) => entry.name)).toEqual(['Drawings', 'A.txt', 'PLC.ACD'])
    expect(result.entries[0]).toEqual({ kind: 'directory', name: 'Drawings', handle: child })
    expect(result.entries[2]).toEqual({ kind: 'file', name: 'PLC.ACD' })
    expect(result.truncated).toBe(false)
    expect(getFile).not.toHaveBeenCalled()
    expect(childValues).not.toHaveBeenCalled()
  })

  it('bounds enumeration and closes the iterator; explains access and missing-folder failures', async () => {
    let visited = 0
    let closed = false
    const root = { async *values() { try { while (true) { visited++; yield { kind: 'file', name: `file-${visited}` } } } finally { closed = true } } } as unknown as FileSystemDirectoryHandle
    const result = await listReadOnlyFolder(root)
    expect(result.entries).toHaveLength(FOLDER_ENTRY_LIMIT)
    expect(result.truncated).toBe(true)
    expect(visited).toBe(FOLDER_ENTRY_LIMIT + 1)
    expect(closed).toBe(true)
    expect(folderBrowseError(new DOMException('', 'NotAllowedError'))).toMatch(/Reconnect/)
    expect(folderBrowseError(new DOMException('', 'NotFoundError'))).toMatch(/moved/)
  })
})
