import { useEffect, useRef, useState } from 'react'
import type { Attachment } from '../cloud/api'
import { useCloud } from '../cloud/context'
import { attachmentIcon, categoryName, formatSize, previewKind } from '../lib/attachments'
import { parseCsv } from '../lib/csv'
import { Modal } from './Modal'

/** Most rows of a spreadsheet or CSV shown at once; the rest are in the download. */
const MAX_ROWS = 500
/** Most text shown; longer files are cut. */
const MAX_TEXT = 1_000_000

type Sheet = { name: string; rows: string[][] }

type Loaded =
  | { kind: 'word'; blob: Blob }
  | { kind: 'sheets'; sheets: Sheet[] }
  | { kind: 'pdf' | 'image'; url: string }
  | { kind: 'text'; text: string; cut: boolean }

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toLocaleDateString()
  return String(value)
}

async function load(file: Attachment, blob: Blob): Promise<Loaded> {
  const kind = previewKind(file.name)
  if (kind === 'word') return { kind: 'word', blob }
  if (kind === 'excel') {
    const { default: readXlsxFile } = await import('read-excel-file/browser')
    const sheets = await readXlsxFile(blob)
    return { kind: 'sheets', sheets: sheets.map((s) => ({ name: s.sheet, rows: s.data.map((r) => r.map(cellText)) })) }
  }
  if (kind === 'pdf' || kind === 'image') return { kind, url: URL.createObjectURL(new Blob([blob], { type: file.type })) }
  const text = await blob.text()
  if (file.name.toLowerCase().endsWith('.csv')) return { kind: 'sheets', sheets: [{ name: file.name, rows: parseCsv(text) }] }
  return { kind: 'text', text: text.slice(0, MAX_TEXT), cut: text.length > MAX_TEXT }
}

/**
 * Shows an attached file in the app: Word through docx-preview, Excel and CSV
 * as tables, PDF in the browser's viewer, images, and text files as they are.
 * The file is read here, in the page, so the server keeps serving every file
 * as a download.
 */
export function FilePreview({ file, onClose }: { file: Attachment; onClose: () => void }) {
  const cloud = useCloud()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    if (!cloud) return
    let cancelled = false
    let url: string | null = null
    cloud.api
      .fetchAttachment(file.id)
      .then((blob) => load(file, blob))
      .then((result) => {
        if ('url' in result) url = result.url
        if (cancelled) {
          if (url) URL.revokeObjectURL(url)
        } else setLoaded(result)
      })
      .catch((error: unknown) => {
        if (!cancelled) setProblem(error instanceof Error ? error.message : 'Could not open this file.')
      })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [cloud, file])

  if (!cloud) return null
  return (
    <Modal title={`View ${file.name}`} onClose={onClose} full>
      <div className="preview-head">
        <h2>
          <span aria-hidden>{attachmentIcon(file.name)}</span> {file.name}
        </h2>
        <small className="muted">
          {categoryName[file.category]} · {formatSize(file.size)}
          {file.uploadedBy && ` · ${file.uploadedBy}`}
        </small>
        <a className="button" href={cloud.api.attachmentUrl(file.id)} download={file.name}>
          ⬇ Download
        </a>
      </div>
      <div className="preview-body">
        {problem ? (
          <p className="date-warning" role="alert">
            ⚠ This file could not be shown ({problem}). Download it to open it instead.
          </p>
        ) : !loaded ? (
          <p className="muted" role="status">
            Opening {file.name}…
          </p>
        ) : (
          <PreviewContent loaded={loaded} name={file.name} onProblem={setProblem} />
        )}
      </div>
    </Modal>
  )
}

function PreviewContent({ loaded, name, onProblem }: { loaded: Loaded; name: string; onProblem: (p: string) => void }) {
  switch (loaded.kind) {
    case 'word':
      return <WordView blob={loaded.blob} onProblem={onProblem} />
    case 'sheets':
      return <SheetsView sheets={loaded.sheets} />
    case 'pdf':
      return <iframe className="preview-pdf" src={loaded.url} title={name} />
    case 'image':
      return <img className="preview-image" src={loaded.url} alt={name} />
    case 'text':
      return (
        <>
          <pre className="preview-text">{loaded.text}</pre>
          {loaded.cut && <small className="muted">Only the start of this file is shown. Download it for the rest.</small>}
        </>
      )
  }
}

/** Links in a Word file may only go to web pages, mail or places in the document. */
function tidyLinks(root: HTMLElement) {
  for (const el of root.querySelectorAll('script, iframe, object, embed, form')) el.remove()
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? ''
    if (/^(https?:|mailto:)/i.test(href)) {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
    } else if (!href.startsWith('#')) a.removeAttribute('href')
  }
}

function WordView({ blob, onProblem }: { blob: Blob; onProblem: (p: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let cancelled = false
    import('docx-preview')
      .then(({ renderAsync }) =>
        renderAsync(blob, el, el, {
          className: 'docx',
          inWrapper: true,
          ignoreLastRenderedPageBreak: true,
          renderComments: false,
          renderChanges: false,
          renderAltChunks: false,
          useBase64URL: true,
        }),
      )
      .then(() => {
        if (cancelled) return
        tidyLinks(el)
        setReady(true)
      })
      .catch((error: unknown) => {
        if (!cancelled) onProblem(error instanceof Error ? error.message : 'not a Word file it can read')
      })
    return () => {
      cancelled = true
      el.replaceChildren()
    }
  }, [blob, onProblem])
  return (
    <>
      {!ready && (
        <p className="muted" role="status">
          Laying out the document…
        </p>
      )}
      <div ref={ref} className="preview-word" />
    </>
  )
}

function SheetsView({ sheets }: { sheets: Sheet[] }) {
  const [index, setIndex] = useState(0)
  const sheet = sheets[index] ?? sheets[0]
  if (!sheet) return <p className="muted">This workbook has no sheets.</p>
  const width = Math.max(0, ...sheet.rows.slice(0, MAX_ROWS).map((r) => r.length))
  return (
    <>
      {sheets.length > 1 && (
        <div className="preview-tabs" role="tablist" aria-label="Sheets">
          {sheets.map((s, i) => (
            <button
              key={s.name + i}
              type="button"
              role="tab"
              aria-selected={i === index}
              className={i === index ? 'active' : ''}
              onClick={() => setIndex(i)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      {sheet.rows.length === 0 ? (
        <p className="muted">This sheet is empty.</p>
      ) : (
        <div className="preview-table-wrap">
          <table className="preview-table" aria-label={sheet.name}>
            <tbody>
              {sheet.rows.slice(0, MAX_ROWS).map((row, r) => (
                <tr key={r}>
                  <th scope="row">{r + 1}</th>
                  {Array.from({ length: width }, (_, c) => (
                    <td key={c}>{row[c] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sheet.rows.length > MAX_ROWS && (
        <small className="muted">
          Showing the first {MAX_ROWS} of {sheet.rows.length} rows. Download the file for the rest.
        </small>
      )}
    </>
  )
}
