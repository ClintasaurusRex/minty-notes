import type { RichTextDoc, RichTextNode } from '../domain/types'

const text = (t: string, marks?: RichTextNode['marks']): RichTextNode => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t })
const para = (...content: RichTextNode[]): RichTextNode => ({ type: 'paragraph', content })
const cell = (type: 'tableCell' | 'tableHeader', t: string): RichTextNode => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null }, content: [t ? para(text(t)) : { type: 'paragraph' }] })

/** A note with a heading, a 3×3 I/O table, a code block, inline code, and a link to another page. */
export function technicalDoc(linkedPageId: string): RichTextDoc {
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [text('Pump station I/O')] },
      {
        type: 'table',
        content: [
          { type: 'tableRow', content: [cell('tableHeader', 'Tag'), cell('tableHeader', 'Address'), cell('tableHeader', 'Notes')] },
          { type: 'tableRow', content: [cell('tableCell', 'P101_RUN'), cell('tableCell', 'Local:1:I.Data.0'), cell('tableCell', 'Run feedback')] },
          { type: 'tableRow', content: [cell('tableCell', 'P101_FLT'), cell('tableCell', 'Local:1:I.Data.1'), cell('tableCell', '')] },
        ],
      },
      { type: 'codeBlock', attrs: { language: null }, content: [text('IF P101_RUN AND NOT P101_FLT THEN\n  Pump_OK := 1;\nEND_IF;')] },
      para(text('Scaled with '), text('SCP', [{ type: 'code' }]), text('. See '), text('commissioning steps', [{ type: 'pageLink', attrs: { pageId: linkedPageId } }]), text('.')),
    ],
  }
}
