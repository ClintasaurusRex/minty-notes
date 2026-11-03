import { useRef } from 'react'
import { useServices, useWorkspace } from '../app/context'
import type { PageLocation } from '../domain/types'
import { IMPORT_ACCEPT } from '../import/formats'
import { IconDownload } from './icons'
import { importFileTo } from './importActions'
import { useNav } from './nav'

/** “Import document” (DOCX or text-based PDF) into a location; opens the new draft. */
export function ImportButton({ location, label, variant = 'icon' }: { location: PageLocation; label: string; variant?: 'icon' | 'button' }) {
  const { store } = useServices()
  const nav = useNav()
  const readOnly = useWorkspace((s) => s.readOnly)
  const input = useRef<HTMLInputElement>(null)
  if (readOnly) return null
  return (
    <>
      {variant === 'icon' ? (
        <button type="button" className="icon-btn small" aria-label={label} title={`${label} (.docx or text-based PDF)`} onClick={() => input.current?.click()} data-testid="import-document">
          <IconDownload size={15} />
        </button>
      ) : (
        <button type="button" className="btn btn-small" title=".docx or text-based PDF; the original file is kept" onClick={() => input.current?.click()} data-testid="import-document">
          <IconDownload size={14} /> {label}
        </button>
      )}
      <input
        ref={input}
        type="file"
        accept={IMPORT_ACCEPT}
        hidden
        data-testid="import-file"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) void importFileTo(file, location, store, (id, projectId) => nav.openPage(id, projectId))
        }}
      />
    </>
  )
}
