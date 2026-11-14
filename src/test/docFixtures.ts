import { strToU8, zipSync } from 'fflate'

/**
 * Synthetic import fixtures, built byte by byte (no real customer files):
 * a Word document with headings, formatting, a list, a table (including a
 * hostile column span), links (one `javascript:`), a PNG and an EMF picture,
 * and text that looks like HTML; and a three-page text PDF with a heading,
 * wrapped paragraphs, hyphenation, bullets, an inline image, a page without
 * text, and a document script.
 */

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'

const para = (text: string, style?: string, runProps = '') =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r>${runProps ? `<w:rPr>${runProps}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
const cell = (text: string, span = 1) => `<w:tc>${span > 1 ? `<w:tcPr><w:gridSpan w:val="${span}"/></w:tcPr>` : ''}${para(text)}</w:tc>`
const picture = (rel: string, name: string) =>
  `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><wp:docPr id="1" name="${name}" descr="${name}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rel}"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`

/** A 16 × 8 PNG (mint and charcoal halves) to stand in for a photo in the document. */
export const DOCX_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAABAAAAAICAIAAAB/FOjAAAAAGElEQVR4nGPIe74dKxKRlsKKGEY10EIDAILBlUEswXvNAAAAAElFTkSuQmCC'),
  (c) => c.charCodeAt(0),
)

export function makeDocx(opts: { extraParagraphs?: number; withMacros?: boolean } = {}): Uint8Array {
  const body = [
    para('Pump Station 3 — Commissioning Procedure', 'Title'),
    para('Scope', 'Heading1'),
    `<w:p><w:r><w:t xml:space="preserve">This procedure covers the </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>VTScada</w:t></w:r><w:r><w:t xml:space="preserve"> tags and the </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>Studio 5000</w:t></w:r><w:r><w:t xml:space="preserve"> logic. </w:t></w:r><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>Never</w:t></w:r><w:r><w:t xml:space="preserve"> bypass interlocks.</w:t></w:r></w:p>`,
    `<w:p><w:r><w:t xml:space="preserve">See the </w:t></w:r><w:hyperlink r:id="rIdLink1"><w:r><w:t>vendor manual</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> and </w:t></w:r><w:hyperlink r:id="rIdLink2"><w:r><w:t>this bad link</w:t></w:r></w:hyperlink><w:r><w:t>.</w:t></w:r></w:p>`,
    para('&lt;script&gt;window.__pwned = true&lt;/script&gt; is shown as text, never run.'),
    para('Checks', 'Heading2'),
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Verify 24 VDC at terminal X2:14</w:t></w:r></w:p>`,
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Force P101_RUN and watch the HMI</w:t></w:r></w:p>`,
    para('I/O list', 'Heading2'),
    `<w:tbl><w:tr>${cell('Tag')}${cell('Address')}${cell('Notes')}</w:tr><w:tr>${cell('P101_RUN')}${cell('Local:1:I.Data.0')}${cell('Run feedback')}</w:tr><w:tr>${cell('Spare (merged)', 9999)}</w:tr></w:tbl>`,
    picture('rIdImg1', 'panel.png'),
    picture('rIdImg2', 'wiring.emf'),
    para('End of procedure.'),
    ...Array.from({ length: opts.extraParagraphs ?? 0 }, (_, i) => para(`Extra paragraph ${i + 1}: lorem ipsum dolor sit amet, consectetur adipiscing elit.`)),
  ].join('')
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="emf" ContentType="image/x-emf"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    'word/_rels/document.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '<Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
        '<Relationship Id="rIdLink1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/manual" TargetMode="External"/>' +
        '<Relationship Id="rIdLink2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>' +
        '<Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>' +
        '<Relationship Id="rIdImg2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image2.emf"/>' +
        '</Relationships>',
    ),
    'word/styles.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}>` +
        ['Title:Title', 'Heading1:heading 1', 'Heading2:heading 2'].map((s) => {
          const [id, name] = s.split(':')
          return `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/></w:style>`
        }).join('') +
        '</w:styles>',
    ),
    'word/numbering.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
    ),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`),
    'word/media/image1.png': DOCX_PNG,
    'word/media/image2.emf': new Uint8Array([1, 0, 0, 0, 0x6c, 0, 0, 0, 0x20, 0x45, 0x4d, 0x46]),
  }
  if (opts.withMacros) files['word/vbaProject.bin'] = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])
  return zipSync(files)
}

/** Build a PDF from page content streams (Helvetica as /F1). Offsets are computed exactly. */
export function makePdf(pages: Uint8Array[], opts: { script?: boolean } = {}): Uint8Array {
  const enc = (s: string) => strToU8(s, true)
  const objects: Uint8Array[][] = []
  const pageIds = pages.map((_, i) => 4 + i * 2)
  const catalog = `<< /Type /Catalog /Pages 2 0 R${opts.script ? ' /Names << /JavaScript << /Names [(init) << /S /JavaScript /JS (app.alert\\(1\\)) >>] >> >> /OpenAction << /S /JavaScript /JS (app.alert\\(2\\)) >>' : ''} >>`
  objects.push([enc(catalog)])
  objects.push([enc(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`)])
  objects.push([enc('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')])
  pages.forEach((content, i) => {
    objects.push([enc(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageIds[i] + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`)])
    objects.push([enc(`<< /Length ${content.byteLength} >>\nstream\n`), content, enc('\nendstream')])
  })
  const chunks: Uint8Array[] = [enc('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')]
  let offset = chunks[0].byteLength
  const offsets: number[] = []
  objects.forEach((parts, i) => {
    offsets.push(offset)
    const all = [enc(`${i + 1} 0 obj\n`), ...parts, enc('\nendobj\n')]
    for (const p of all) {
      chunks.push(p)
      offset += p.byteLength
    }
  })
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`
  chunks.push(enc(xref))
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

const text = (s: string) => strToU8(s, true)

/** Three pages: heading + wrapped paragraph with hyphenation; bullets + an inline image; no text at all. */
export function makeTechnicalPdf(opts: { script?: boolean } = {}): Uint8Array {
  const page1 = text(
    'BT /F1 22 Tf 72 720 Td (Lift Station 7 Control Narrative) Tj ET\n' +
      'BT /F1 11 Tf 72 680 Td (The duty pump starts when the wet well level rises above the) Tj 0 -14 Td (start setpoint. The standby pump is alternated every cycle to bal-) Tj 0 -14 Td (ance run hours across both pumps.) Tj ET\n' +
      'BT /F1 11 Tf 72 600 Td (A high-level float provides a hardwired backup start.) Tj ET\n',
  )
  const image = new Uint8Array([0x00, 0xff, 0xff, 0x00])
  const page2Parts = [
    text('BT /F1 16 Tf 72 720 Td (Alarm Checks) Tj ET\n'),
    text('BT /F1 11 Tf 72 690 Td (- Verify the high-level alarm reaches VTScada) Tj 0 -16 Td (- Confirm the pump fail alarm latches) Tj ET\n'),
    text('q 40 0 0 40 400 600 cm BI /W 2 /H 2 /CS /G /BPC 8 ID '),
    image,
    text(' EI Q\n'),
  ]
  const page2 = new Uint8Array(page2Parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for (const p of page2Parts) {
    page2.set(p, at)
    at += p.byteLength
  }
  const page3 = text('0.3 0.3 0.3 rg 72 400 300 200 re f\n')
  return makePdf([page1, page2, page3], opts)
}
