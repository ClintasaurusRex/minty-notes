import { useId, useState } from 'react'
import { useServices, useWorkspace } from '../app/context'
import { normalize } from '../domain/search'
import { ReadOnlyError } from '../store/workspaceStore'
import { notify } from './notices'

interface Props {
  kind: 'category' | 'tag'
  /** IDs set on this record. */
  selected: string[]
  /** IDs inherited from a parent (shown, not removable here). */
  inherited?: { id: string; from: string }[]
  onChange: (ids: string[]) => void
  /** Accessible name of the add field, e.g. "Add category to this page". */
  label: string
}

/** Chips for categories or tags, with a field that adds an existing one or creates it. */
export function LabelPicker({ kind, selected, inherited = [], onChange, label }: Props) {
  const { store } = useServices()
  const categories = useWorkspace((s) => s.data.categories)
  const tags = useWorkspace((s) => s.data.tags)
  const readOnly = useWorkspace((s) => s.readOnly)
  const [draft, setDraft] = useState('')
  const listId = useId()
  const all = kind === 'category' ? categories : tags
  const noun = kind === 'category' ? 'category' : 'tag'
  const inheritedIds = new Set(inherited.map((i) => i.id))
  const options = Object.values(all)
    .filter((o) => !selected.includes(o.id) && !inheritedIds.has(o.id))
    .sort((a, b) => a.name.localeCompare(b.name))

  const add = () => {
    const name = draft.trim().replace(kind === 'tag' ? /^#/ : /^$/, '')
    if (!name) return
    try {
      const existing = Object.values(all).find((o) => normalize(o.name) === normalize(name))
      const id = existing?.id ?? (kind === 'category' ? store.createCategory(name).id : store.createTag(name).id)
      if (!selected.includes(id)) onChange([...selected, id])
      setDraft('')
    } catch (err) {
      if (err instanceof ReadOnlyError) notify('info', err.message)
      else throw err
    }
  }

  return (
    <div className={`labels labels-${kind}`}>
      {inherited.map(({ id, from }) =>
        all[id] ? (
          <span key={`i-${id}`} className={`chip chip-${kind} chip-inherited`} title={`From ${from}`}>
            {all[id].name}
          </span>
        ) : null,
      )}
      {selected.map((id) =>
        all[id] ? (
          <span key={id} className={`chip chip-${kind}`}>
            {kind === 'tag' ? '#' : ''}
            {all[id].name}
            {!readOnly && (
              <button type="button" className="chip-x" aria-label={`Remove ${noun} ${all[id].name}`} onClick={() => onChange(selected.filter((x) => x !== id))}>
                ×
              </button>
            )}
          </span>
        ) : null,
      )}
      {!readOnly && (
        <>
          <input
            className="label-input"
            aria-label={label}
            placeholder={kind === 'category' ? '+ category' : '+ tag'}
            list={listId}
            value={draft}
            onChange={(e) => {
              const v = e.target.value
              setDraft(v)
              // Choosing an entry from the suggestion list adds it right away.
              const native = e.nativeEvent as InputEvent
              const picked = !native.inputType || native.inputType === 'insertReplacementText'
              if (picked && options.some((o) => o.name === v)) {
                const match = options.find((o) => o.name === v)!
                onChange([...selected, match.id])
                setDraft('')
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
              if (e.key === 'Escape') setDraft('')
            }}
            onBlur={() => {
              if (draft.trim()) add()
            }}
          />
          <datalist id={listId}>
            {options.map((o) => (
              <option key={o.id} value={o.name} />
            ))}
          </datalist>
        </>
      )}
      {readOnly && selected.length === 0 && inherited.length === 0 && <span className="muted small">No {noun === 'category' ? 'categories' : 'tags'}</span>}
    </div>
  )
}
