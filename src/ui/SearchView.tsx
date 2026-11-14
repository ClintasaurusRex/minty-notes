import { useEffect, useState } from 'react'
import { useServices, useWorkspace } from '../app/context'
import { DEFAULT_FILTERS, SEARCH_KIND_LABELS, search, type PageText, type SearchFilters, type SearchKind } from '../domain/search'
import { describeStorageError } from '../storage/repository'
import { relativeTime } from './format'
import { IconSearch } from './icons'
import { useNav } from './nav'
import { notify } from './notices'

const KINDS: SearchKind[] = ['project', 'project-note', 'reference', 'note', 'task', 'attachment']

export function SearchView() {
  const { store } = useServices()
  const nav = useNav()
  const data = useWorkspace((s) => s.data)
  const revision = useWorkspace((s) => s.data.revision)
  const epoch = useWorkspace((s) => s.epoch)
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<SearchFilters>(DEFAULT_FILTERS)
  const [texts, setTexts] = useState<Map<string, PageText> | null>(null)

  // Page text is read from storage when search opens and after saved changes.
  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      store
        .loadSearchTexts()
        .then((map) => alive && setTexts(map))
        .catch((err: unknown) => notify('error', `Search could not read page text: ${describeStorageError(err)}`))
    }, 150)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [store, revision, epoch])

  const results = texts ? search(query, filters, data, texts) : []
  const set = (patch: Partial<SearchFilters>) => setFilters((f) => ({ ...f, ...patch }))
  const toggleKind = (k: SearchKind) => set({ kinds: filters.kinds.includes(k) ? filters.kinds.filter((x) => x !== k) : [...filters.kinds, k] })
  const projects = Object.values(data.projects)
    .filter((p) => !p.trashedAt && (filters.includeArchived || !p.archivedAt))
    .sort((a, b) => a.name.localeCompare(b.name))
  const active = query.trim() || filters.project !== 'all' || filters.category !== 'all' || filters.tag !== 'all' || filters.kinds.length > 0

  return (
    <div className="search-view" data-testid="search-view">
      <h1>Search</h1>
      <div className="search-box">
        <IconSearch size={18} />
        <input type="search" aria-label="Search" placeholder="Projects, notes, tasks, tags, attachment names…" value={query} autoFocus onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="search-filters" role="group" aria-label="Filters">
        <div className="kind-toggles" role="group" aria-label="Result types">
          {KINDS.map((k) => (
            <button key={k} type="button" className={`toggle${filters.kinds.includes(k) ? ' is-on' : ''}`} aria-pressed={filters.kinds.includes(k)} onClick={() => toggleKind(k)}>
              {SEARCH_KIND_LABELS[k]}
            </button>
          ))}
        </div>
        <label>
          <span className="sr-only">Project</span>
          <select aria-label="Project filter" value={filters.project} onChange={(e) => set({ project: e.target.value })}>
            <option value="all">All projects and notes</option>
            <option value="none">Not in a project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.archivedAt ? ' (archived)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Category</span>
          <select aria-label="Category filter" value={filters.category} onChange={(e) => set({ category: e.target.value })}>
            <option value="all">Any category</option>
            {Object.values(data.categories)
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Tag</span>
          <select aria-label="Tag filter" value={filters.tag} onChange={(e) => set({ tag: e.target.value })}>
            <option value="all">Any tag</option>
            {Object.values(data.tags)
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((t) => (
                <option key={t.id} value={t.id}>
                  #{t.name}
                </option>
              ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={filters.includeArchived} onChange={(e) => set({ includeArchived: e.target.checked })} /> Include archived projects
        </label>
      </div>
      {!texts ? (
        <p className="muted">Preparing search…</p>
      ) : !active ? (
        <p className="muted">Type to search project details, note titles and text, tags, categories, and attachment names. Everything is searched on this computer.</p>
      ) : results.length === 0 ? (
        <p className="muted" role="status">
          No results.
        </p>
      ) : (
        <>
          <p className="muted small" role="status">
            {results.length} result{results.length === 1 ? '' : 's'}
          </p>
          <ul className="search-results" data-testid="search-results">
            {results.slice(0, 200).map((r) => (
              <li key={`${r.kind}:${r.key}`}>
                <button type="button" className="result" onClick={() => (r.pageId ? nav.openPage(r.pageId, r.projectId) : r.taskId ? nav.openProject(r.projectId, { tab: 'tasks', taskId: r.taskId }) : nav.openProject(r.projectId))}>
                  <span className="result-top">
                    <span className={`badge kind-${r.kind}`}>{SEARCH_KIND_LABELS[r.kind]}</span>
                    <span className="result-title">{r.title}</span>
                  </span>
                  <span className="result-context">
                    {r.context} · {relativeTime(r.updatedAt)}
                  </span>
                  {r.snippet && <span className="result-snippet">{r.snippet}</span>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
