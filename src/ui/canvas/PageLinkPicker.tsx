import { useEffect, useId, useRef, useState } from 'react'
import { useWorkspace } from '../../app/context'
import { tokenize, normalize } from '../../domain/search'
import type { Page } from '../../domain/types'
import { locationLabel } from '../locations'

const MAX_RESULTS = 60

/**
 * Choose a page to link to. Type to filter by title or location; ↑/↓ move,
 * Enter links, Esc cancels. Trashed pages are not offered.
 */
export function PageLinkPicker({ currentPageId, initialQuery, onChoose, onCancel }: { currentPageId: string; initialQuery: string; onChoose: (page: Page) => void; onCancel: () => void }) {
  const data = useWorkspace((s) => s.data)
  const [query, setQuery] = useState(initialQuery)
  const [active, setActive] = useState(0)
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()
  const headingId = useId()

  useEffect(() => {
    const d = dialog.current
    if (d && !d.open) d.showModal()
    input.current?.focus()
    input.current?.select()
    return () => {
      if (d?.open) d.close()
    }
  }, [])

  const words = tokenize(query)
  const results = Object.values(data.pages)
    .filter((p) => !p.trashedAt && p.id !== currentPageId)
    .map((p) => ({ page: p, where: locationLabel(p.location, data) }))
    .filter(({ page, where }) => {
      const hay = normalize(`${page.title} ${where}`)
      return words.every((w) => hay.includes(w))
    })
    .sort((a, b) => {
      // Title matches first, then most recently edited.
      const at = words.length > 0 && normalize(a.page.title).includes(words[0]) ? 0 : 1
      const bt = words.length > 0 && normalize(b.page.title).includes(words[0]) ? 0 : 1
      return at - bt || b.page.updatedAt.localeCompare(a.page.updatedAt)
    })
    .slice(0, MAX_RESULTS)
  const current = Math.min(active, Math.max(0, results.length - 1))

  // Close the dialog before reporting back: closing returns focus to the text
  // box, and the caller then restores the selection on top of that.
  const finish = (fn: () => void) => {
    if (dialog.current?.open) dialog.current.close()
    fn()
  }
  const cancel = () => finish(onCancel)
  const choose = (i: number) => {
    const hit = results[i]
    if (hit) finish(() => onChoose(hit.page))
  }

  return (
    <dialog
      ref={dialog}
      className="dialog page-picker"
      aria-labelledby={headingId}
      data-testid="page-link-picker"
      onCancel={(e) => {
        e.preventDefault()
        cancel()
      }}
      onMouseDown={(e) => e.target === e.currentTarget && cancel()}
    >
      <h2 id={headingId}>Link to a page</h2>
      <p className="muted small">The link follows the page if it is moved or renamed. Ctrl+click or Alt+Enter on a link opens it.</p>
      <input
        ref={input}
        className="picker-input"
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={results[current] ? `${listId}-${current}` : undefined}
        aria-label="Search pages by title or location"
        placeholder="Search pages…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive(Math.min(current + 1, results.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive(Math.max(current - 1, 0))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            choose(current)
          } else if (e.key === 'Escape') {
            // One Esc always closes (a search field would otherwise just clear itself).
            e.preventDefault()
            cancel()
          }
        }}
      />
      <ul className="picker-list" id={listId} role="listbox" aria-label="Pages">
        {results.map(({ page, where }, i) => (
          <li
            key={page.id}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === current}
            className={i === current ? 'is-active' : ''}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(i)}
            onClick={() => choose(i)}
          >
            <span className="picker-title">{page.title || 'Untitled'}</span>
            <span className="picker-where">{where}</span>
          </li>
        ))}
        {results.length === 0 && <li className="muted small picker-empty">No matching pages.</li>}
      </ul>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={cancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" disabled={!results[current]} onClick={() => choose(current)}>
          Link
        </button>
      </div>
    </dialog>
  )
}
