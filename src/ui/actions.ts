import type { Template } from '../domain/types'
import { ReadOnlyError } from '../store/workspaceStore'
import { notify } from './notices'

/** Run a store action; a read-only window shows a notice instead of throwing. */
export function guard(fn: () => void): void {
  try {
    fn()
  } catch (err) {
    if (err instanceof ReadOnlyError) notify('info', err.message)
    else throw err
  }
}

/** Async version of guard: also reports other errors as a notice. */
export async function guardAsync(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    notify(err instanceof ReadOnlyError ? 'info' : 'error', err instanceof Error ? err.message : String(err))
  }
}

export async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    notify('success', `${what} copied`)
  } catch {
    notify('error', 'The browser did not allow copying. Select the text and copy it instead.')
  }
}

/** Ask for a template name, then save (the source stays as it is). */
export function saveAsTemplate(kind: Template['kind'], defaultName: string, create: (name: string) => Promise<Template>): Promise<void> {
  const name = window.prompt(kind === 'note' ? 'Name for the new note template:' : 'Name for the new project template (keeps settings, notes, and tasks; not customer, job number, contacts, or dates):', defaultName)
  if (name === null) return Promise.resolve()
  return guardAsync(async () => {
    const t = await create(name)
    notify('success', `Saved the template “${t.name}”. Find it under “New from template”, and manage it in Settings.`)
  })
}
