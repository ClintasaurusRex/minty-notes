import { describe, expect, it } from 'vitest'
import { sha256Hex } from '../backup/archive'
import { freshStore, PNG_1x1 } from '../test/fixtures'
import { dueState, formatDateOnly, isDateOnly, todayDateOnly } from './dates'
import { docFromPlainText } from './richtext'
import { DEFAULT_FILTERS, makeSnippet, search, type SearchFilters } from './search'
import { newId, nowIso } from './types'

async function workspace() {
  const { store } = await freshStore()
  const vt = store.createCategory('VTScada')
  const studio = store.createCategory('Studio 5000')
  const { section } = store.createNotebook('VTScada reference', [vt.id])
  const ref = store.createPage({ kind: 'section', sectionId: section.id }, 'Historian setup')
  const project = store.createProject({
    name: 'North pump station',
    customer: 'Weidmüller Water',
    jobNumber: 'J-2041',
    categoryIds: [vt.id],
    software: [{ id: newId(), name: 'VTScada', detail: '12.1.40' }],
    contacts: [{ id: newId(), name: 'Dana Example', role: 'Operator', phone: '', email: 'dana@example.com' }],
  })
  const archived = store.createProject({ name: 'Old pump station', categoryIds: [studio.id] })
  store.setProjectArchived(archived.id, true)
  const note = store.createPage({ kind: 'project', projectId: project.id }, 'Commissioning day 1')
  const oldNote = store.createPage({ kind: 'project', projectId: archived.id }, 'Old pump notes')
  const inbox = store.createPage({ kind: 'inbox' }, 'Quick idea')
  const tag = store.createTag('alarms')
  store.setPageTags(inbox.id, [tag.id])
  const at = nowIso()
  const attachmentId = newId()
  await store.addAttachment(
    { id: attachmentId, fileName: 'pump-curve.png', mimeType: 'image/png', size: 1, sha256: await sha256Hex(PNG_1x1), width: 1, height: 1, source: 'file', createdAt: at },
    new Blob([PNG_1x1]),
  )
  store.addObjects(note.id, [
    { id: newId(), pageId: note.id, type: 'text', x: 0, y: 0, w: 400, h: 40, z: 1, doc: docFromPlainText('Flow meter scaling was off by 10 percent'), createdAt: at, updatedAt: at },
    { id: newId(), pageId: note.id, type: 'image', attachmentId, alt: '', x: 0, y: 80, w: 100, h: 100, z: 2, createdAt: at, updatedAt: at },
  ])
  store.addObjects(oldNote.id, [{ id: newId(), pageId: oldNote.id, type: 'text', x: 0, y: 0, w: 400, h: 40, z: 1, doc: docFromPlainText('flow meter replaced'), createdAt: at, updatedAt: at }])
  store.addObjects(ref.id, [{ id: newId(), pageId: ref.id, type: 'text', x: 0, y: 0, w: 400, h: 40, z: 1, doc: docFromPlainText('Logging interval and flow tags'), createdAt: at, updatedAt: at }])
  await store.flush()
  const texts = await store.loadSearchTexts()
  const run = (q: string, f: Partial<SearchFilters> = {}) => search(q, { ...DEFAULT_FILTERS, ...f }, store.getState().data, texts).map((r) => `${r.kind}:${r.title}`)
  return { store, vt, studio, project, archived, note, ref, inbox, tag, run }
}

describe('local search', () => {
  it('finds project details, note text, tags, and attachment names', async () => {
    const { run } = await workspace()
    expect(run('weidmuller')).toEqual(['project:North pump station']) // accents ignored
    expect(run('J-2041')).toEqual(['project:North pump station'])
    expect(run('12.1.40')).toEqual(['project:North pump station'])
    expect(run('dana@example')).toEqual(['project:North pump station'])
    expect(run('scaling percent')).toEqual(['project-note:Commissioning day 1'])
    expect(run('alarms')).toEqual(['note:Quick idea'])
    expect(run('pump-curve')).toEqual(['attachment:pump-curve.png'])
    expect(run('nothing-matches-this')).toEqual([])
    expect(run('')).toEqual([])
  })

  it('filters by project (its notes and linked references), category, tag, kind, and archive state', async () => {
    const { run, project, vt, studio, tag } = await workspace()
    expect(run('flow')).toEqual(expect.arrayContaining(['project-note:Commissioning day 1', 'reference:Historian setup']))
    expect(run('flow')).not.toContain('project-note:Old pump notes') // archived hidden by default
    expect(run('flow', { includeArchived: true })).toContain('project-note:Old pump notes')
    expect(run('flow', { project: project.id }).sort()).toEqual(['project-note:Commissioning day 1', 'reference:Historian setup'])
    expect(run('flow', { project: 'none' })).toEqual(['reference:Historian setup'])
    expect(run('', { category: vt.id }).sort()).toEqual(['project:North pump station', 'reference:Historian setup'])
    expect(run('', { category: studio.id, includeArchived: true })).toEqual(['project:Old pump station'])
    expect(run('', { tag: tag.id })).toEqual(['note:Quick idea'])
    expect(run('flow', { kinds: ['reference'] })).toEqual(['reference:Historian setup'])
  })

  it('skips trashed pages and trashed projects', async () => {
    const { store, run, project, ref } = await workspace()
    store.trashPage(ref.id)
    store.trashProject(project.id)
    expect(run('flow')).toEqual([])
  })

  it('makes short snippets around the match', () => {
    const text = 'a '.repeat(100) + 'needle' + ' b'.repeat(100)
    const s = makeSnippet(text, ['needle'], 20)
    expect(s).toMatch(/^….*needle.*…$/)
    expect(s.length).toBeLessThan(60)
  })
})

describe('date-only due dates', () => {
  it('validates, formats, and compares calendar dates without time zones', () => {
    expect(isDateOnly('2026-02-28')).toBe(true)
    expect(isDateOnly('2026-02-30')).toBe(false)
    expect(isDateOnly('2026-2-3')).toBe(false)
    // Chrome's date field gives these for a two-digit year (valid) and gave this for a five-digit one (invalid).
    expect(isDateOnly('0099-12-15')).toBe(true)
    expect(isDateOnly('0001-01-01')).toBe(true)
    expect(isDateOnly('20261-12-15')).toBe(false)
    expect(dueState('0099-12-15', '2026-11-02').tone).toBe('overdue')
    expect(formatDateOnly('2026-12-15')).toMatch(/15/)
    expect(dueState('2026-11-01', '2026-11-02').tone).toBe('overdue')
    expect(dueState('2026-11-02', '2026-11-02').tone).toBe('today')
    expect(dueState('2026-11-05', '2026-11-02')).toEqual({ tone: 'soon', text: 'Due in 3 days' })
    expect(dueState('2027-01-05', '2026-11-02').tone).toBe('later')
    expect(todayDateOnly(new Date(2026, 0, 9, 23, 59))).toBe('2026-01-09')
  })
})
