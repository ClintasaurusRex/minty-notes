import { useServices, useWorkspace } from '../../app/context'
import type { Page, PageLocation } from '../../domain/types'
import { IconTrash } from '../icons'
import { ToolButton } from './Toolbar'
import { locationLabel, locationKey, parseLocationKey, useLocationOptions } from '../locations'
import { notify } from '../notices'
import { shortDateTime } from '../format'

interface Props {
  page: Page
  onLeave: () => void
  zoom: 'fit' | 'actual'
  scale: number
  onZoom: (zoom: 'fit' | 'actual') => void
}

export function PageHeader({ page, onLeave, zoom, scale, onZoom }: Props) {
  const { store } = useServices()
  const readOnly = useWorkspace((s) => s.readOnly)
  const data = useWorkspace((s) => s.data)
  const options = useLocationOptions()

  const move = (location: PageLocation) => {
    store.movePage(page.id, location)
    notify('success', `Moved to ${locationLabel(location, data)}`)
  }

  return (
    <header className="page-header">
      <div className="page-header-main">
        <div className="crumbs" aria-label="Location">
          {locationLabel(page.location, data)}
          <span className="muted"> · created {shortDateTime(page.createdAt)}</span>
        </div>
        <input
          className="page-title"
          value={page.title}
          readOnly={readOnly}
          aria-label="Page title"
          placeholder="Untitled"
          onChange={(e) => store.renamePage(page.id, e.target.value)}
          onBlur={(e) => {
            if (!e.target.value.trim() && !readOnly) store.renamePage(page.id, 'Untitled page')
          }}
        />
      </div>
      <div className="page-header-actions">
        <div className="tool-group" role="group" aria-label="Zoom">
          <ToolButton label="Fit page to window width" active={zoom === 'fit'} onClick={() => onZoom('fit')} wide>
            Fit
          </ToolButton>
          <ToolButton label="Actual size (100%)" active={zoom === 'actual'} onClick={() => onZoom('actual')} wide>
            100%
          </ToolButton>
          <span className="zoom-readout" aria-live="polite">
            {Math.round(scale * 100)}%
          </span>
        </div>
      {!readOnly && (
        <>
          <label className="move-select">
            <span className="sr-only">Move page to</span>
            <select
              value={locationKey(page.location)}
              onChange={(e) => {
                const loc = parseLocationKey(e.target.value)
                if (loc) move(loc)
              }}
              title="Move this page"
            >
              {options.map((group) =>
                group.options.length === 1 && !group.label ? (
                  <option key={group.options[0].key} value={group.options[0].key}>
                    {group.options[0].label}
                  </option>
                ) : (
                  <optgroup key={group.label} label={group.label}>
                    {group.options.map((o) => (
                      <option key={o.key} value={o.key}>
                        {o.label}
                      </option>
                    ))}
                  </optgroup>
                ),
              )}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              store.trashPage(page.id)
              notify('info', `“${page.title}” moved to Trash`)
              onLeave()
            }}
          >
            <IconTrash size={16} /> Trash
          </button>
        </>
      )}
      </div>
    </header>
  )
}
