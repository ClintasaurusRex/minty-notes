import { useServices, useWorkspace } from '../app/context'
import type { Template } from '../domain/types'
import { guard } from './actions'
import { relativeTime } from './format'
import { IconTrash } from './icons'

/** A compact "New from template…" picker. Lists templates of the given kinds. */
export function TemplatePicker({ kinds, label, onPick }: { kinds: Template['kind'][]; label: string; onPick: (t: Template) => void }) {
  const templates = useWorkspace((s) => s.data.templates)
  const readOnly = useWorkspace((s) => s.readOnly)
  const list = Object.values(templates)
    .filter((t) => kinds.includes(t.kind))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
  if (readOnly || list.length === 0) return null
  return (
    <label className="template-picker">
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        value=""
        onChange={(e) => {
          const t = templates[e.target.value]
          if (t) onPick(t)
        }}
        data-testid="template-picker"
      >
        <option value="">{label}</option>
        {kinds.map((kind) => {
          const group = list.filter((t) => t.kind === kind)
          if (group.length === 0) return null
          return (
            <optgroup key={kind} label={kind === 'note' ? 'Note templates' : 'Project templates'}>
              {group.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </optgroup>
          )
        })}
      </select>
    </label>
  )
}

function describe(t: Template): string {
  const objects = t.notes.reduce((n, x) => n + x.objects.length, 0)
  if (t.kind === 'note') return `Note template · ${objects} item${objects === 1 ? '' : 's'}`
  return `Project template · ${t.notes.length} note${t.notes.length === 1 ? '' : 's'} · ${t.tasks.length} task${t.tasks.length === 1 ? '' : 's'}`
}

/** Settings card: rename, describe, and delete templates. */
export function TemplatesCard() {
  const { store } = useServices()
  const templates = useWorkspace((s) => s.data.templates)
  const readOnly = useWorkspace((s) => s.readOnly)
  const list = Object.values(templates).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
  return (
    <section className="card" aria-labelledby="templates-h" data-testid="templates-card">
      <h2 id="templates-h">Templates</h2>
      <p className="muted small">
        Save a page with <strong>Save as template</strong> on the page, or a project with <strong>Save as template</strong> in its header. Use them with <strong>New from template</strong> on Home or in a project. Every use makes new, independent notes, tasks, and projects; changing or deleting a template never changes what was made from it.
      </p>
      {list.length === 0 ? (
        <p className="muted small">No templates yet.</p>
      ) : (
        <ul className="row-list">
          {list.map((t) => (
            <li key={t.id} className="template-row" data-testid="template-row">
              <div className="template-fields">
                <input aria-label={`Template name: ${t.name}`} value={t.name} readOnly={readOnly} onChange={(e) => guard(() => store.updateTemplate(t.id, { name: e.target.value }))} />
                <input aria-label={`Template description: ${t.name}`} placeholder="Description (optional)" value={t.description} readOnly={readOnly} onChange={(e) => guard(() => store.updateTemplate(t.id, { description: e.target.value }))} />
              </div>
              <span className="muted small">
                {describe(t)} · saved {relativeTime(t.createdAt)}
              </span>
              {!readOnly && (
                <button
                  type="button"
                  className="icon-btn small"
                  aria-label={`Delete template ${t.name}`}
                  title="Delete template (things made from it stay)"
                  onClick={() => {
                    if (window.confirm(`Delete the template “${t.name}”? Notes and projects made from it are not affected.`)) guard(() => store.deleteTemplate(t.id))
                  }}
                >
                  <IconTrash size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
