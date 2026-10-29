import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { Attachment } from '../cloud/api'
import { useCloud } from '../cloud/context'
import { attachmentIcon, categoryName, formatSize, previewKind } from '../lib/attachments'
import { parseCsv } from '../lib/csv'
import type { ViewSheet, ViewWorkbook } from '../lib/sheetView'
import { Modal } from './Modal'

/** Most rows of a CSV shown at once; the rest are in the download. */
const MAX_ROWS = 500
/** Most text shown; longer files are cut. */
const MAX_TEXT = 1_000_000
/** Most PDF pages drawn. */
const MAX_PAGES = 300
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]

type Loaded =
  | { kind: 'word'; blob: Blob }
  | { kind: 'excel'; workbook: ViewWorkbook; urls: string[] }
  | { kind: 'csv'; rows: string[][] }
  | { kind: 'pdf'; data: ArrayBuffer }
  | { kind: 'image'; url: string }
  | { kind: 'text'; text: string; cut: boolean }

async function load(file: Attachment, blob: Blob): Promise<Loaded> {
  const kind = previewKind(file.name)
  if (kind === 'word' || kind === 'excel') {
    const { loadOfficeFonts } = await import('../lib/officeFonts')
    loadOfficeFonts()
  }
  if (kind === 'word') return { kind: 'word', blob }
  if (kind === 'excel') {
    const [{ default: ExcelJS }, { workbookView }] = await Promise.all([import('exceljs'), import('../lib/sheetView')])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await blob.arrayBuffer())
    const urls: string[] = []
    const media = new Map<string, string>()
    const workbook = workbookView(wb, (id) => {
      if (!media.has(id)) {
        const image = wb.getImage(Number(id)) as { buffer?: ArrayBuffer; base64?: string; extension?: string } | undefined
        if (!image) return undefined
        const ext = image.extension === 'jpg' ? 'jpeg' : (image.extension ?? 'png')
        const bytes = image.buffer
          ? new Uint8Array(image.buffer)
          : image.base64
            ? Uint8Array.from(atob(image.base64.replace(/^data:[^,]*,/, '')), (c) => c.charCodeAt(0))
            : null
        if (!bytes) return undefined
        const url = URL.createObjectURL(new Blob([bytes], { type: `image/${ext}` }))
        urls.push(url)
        media.set(id, url)
      }
      return media.get(id)
    })
    return { kind: 'excel', workbook, urls }
  }
  if (kind === 'pdf') return { kind: 'pdf', data: await blob.arrayBuffer() }
  if (kind === 'image') return { kind, url: URL.createObjectURL(new Blob([blob], { type: file.type })) }
  const text = await blob.text()
  if (file.name.toLowerCase().endsWith('.csv')) return { kind: 'csv', rows: parseCsv(text) }
  return { kind: 'text', text: text.slice(0, MAX_TEXT), cut: text.length > MAX_TEXT }
}

function release(loaded: Loaded) {
  if (loaded.kind === 'image') URL.revokeObjectURL(loaded.url)
  if (loaded.kind === 'excel') for (const url of loaded.urls) URL.revokeObjectURL(url)
}

/**
 * Shows an attached file in the app, laid out like the original: Word pages at
 * their real size with their fonts, Excel sheets with their widths, colours,
 * borders and merged cells, PDF pages drawn as printed. Files are read here,
 * in the page, so the server keeps serving every file as a download.
 */
export function FilePreview({ file, onClose }: { file: Attachment; onClose: () => void }) {
  const cloud = useCloud()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  /** null fits the page to the window; sheets open at their real size. */
  const [zoom, setZoom] = useState<number | null>(previewKind(file.name) === 'excel' ? 1 : null)
  const [shown, setShown] = useState(1)

  useEffect(() => {
    if (!cloud) return
    let cancelled = false
    let result: Loaded | null = null
    cloud.api
      .fetchAttachment(file.id)
      .then((blob) => load(file, blob))
      .then((next) => {
        result = next
        if (cancelled) release(next)
        else setLoaded(next)
      })
      .catch((error: unknown) => {
        if (!cancelled) setProblem(error instanceof Error ? error.message : 'Could not open this file.')
      })
    return () => {
      cancelled = true
      if (result) release(result)
    }
  }, [cloud, file])

  if (!cloud) return null
  const zoomable = loaded && ['word', 'excel', 'pdf'].includes(loaded.kind)
  const step = (dir: 1 | -1) => {
    const now = zoom ?? shown
    const next = dir > 0 ? ZOOM_STEPS.find((z) => z > now + 0.001) : [...ZOOM_STEPS].reverse().find((z) => z < now - 0.001)
    setZoom(next ?? now)
  }
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
        <div className="preview-tools">
          {zoomable && !problem && (
            <div className="preview-zoom" role="group" aria-label="Zoom">
              <button type="button" className="icon-button" aria-label="Zoom out" onClick={() => step(-1)}>
                −
              </button>
              <button
                type="button"
                className="button ghost small-button"
                aria-label="Fit to window"
                title="Fit to window"
                aria-pressed={zoom === null}
                onClick={() => setZoom(null)}
              >
                {Math.round((zoom ?? shown) * 100)}%
              </button>
              <button type="button" className="icon-button" aria-label="Zoom in" onClick={() => step(1)}>
                +
              </button>
            </div>
          )}
          <a className="button" href={cloud.api.attachmentUrl(file.id)} download={file.name}>
            ⬇ Download
          </a>
        </div>
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
          <PreviewContent loaded={loaded} name={file.name} zoom={zoom} onZoom={setShown} onProblem={setProblem} />
        )}
      </div>
    </Modal>
  )
}

interface ViewProps {
  zoom: number | null
  /** Reports the zoom in use, so the toolbar can show it. */
  onZoom: (zoom: number) => void
  onProblem: (problem: string) => void
}

function PreviewContent({ loaded, name, ...view }: ViewProps & { loaded: Loaded; name: string }) {
  switch (loaded.kind) {
    case 'word':
      return <WordView blob={loaded.blob} {...view} />
    case 'excel':
      return <ExcelView workbook={loaded.workbook} {...view} />
    case 'pdf':
      return <PdfView data={loaded.data} name={name} {...view} />
    case 'csv':
      return <CsvView rows={loaded.rows} name={name} />
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

/**
 * The zoom to draw at: the one picked, or, to fit, the width available over
 * the content's own width (never above 100%, so a wide screen shows real size).
 */
function useFitZoom(
  box: RefObject<HTMLElement | null>,
  naturalWidth: number,
  zoom: number | null,
  onZoom: (z: number) => void,
  /** Space around the content that does not scale. */
  padding = 0,
) {
  const [available, setAvailable] = useState(0)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setAvailable(el.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [box])
  const fit =
    available > padding && naturalWidth > padding ? Math.min(1, (available - padding - 2) / (naturalWidth - padding)) : 1
  const used = zoom ?? Math.max(0.1, fit)
  useEffect(() => onZoom(used), [used, onZoom])
  return used
}

/** Links in a Word file may only go to web pages, mail or places in the document. */
function tidyLinks(root: ParentNode) {
  for (const el of root.querySelectorAll('script, iframe, object, embed, form')) el.remove()
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? ''
    if (/^(https?:|mailto:)/i.test(href)) {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
    } else if (!href.startsWith('#')) a.removeAttribute('href')
  }
}

// Word bullets and symbols often use characters from the Symbol and Wingdings
// fonts, which only Windows and Office have; draw the same shapes with Unicode.
const SYMBOLS: Record<string, string> = {
  '\uf0b7': '•',
  '\uf0a7': '▪',
  '\uf06e': '■',
  '\uf071': '❑',
  '\uf076': '❖',
  '\uf0d8': '➢',
  '\uf0e8': '➔',
  '\uf0fc': '✓',
  '\uf0fe': '☑',
  '\uf0a8': '◆',
  '\uf02d': '–',
  '\uf0b0': '°',
  '\uf0ae': '→',
}
const SYMBOL_RE = new RegExp(`[${Object.keys(SYMBOLS).join('')}]`, 'g')
const HAS_SYMBOL = new RegExp(`[${Object.keys(SYMBOLS).join('')}]`)

function fixSymbols(root: ShadowRoot) {
  for (const style of root.querySelectorAll('style')) {
    const text = style.textContent ?? ''
    if (HAS_SYMBOL.test(text)) style.textContent = text.replace(SYMBOL_RE, (ch) => SYMBOLS[ch])
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? ''
    if (HAS_SYMBOL.test(text)) node.nodeValue = text.replace(SYMBOL_RE, (ch) => SYMBOLS[ch])
  }
}

/**
 * A list number or bullet ends with a tab in Word, which puts the text at the
 * hanging indent. A tab in CSS content is just a space, so give the marker the
 * hanging indent's width instead.
 */
function fixListTabs(root: ShadowRoot) {
  const styles = [...root.querySelectorAll('style')]
  const css = styles.map((s) => s.textContent).join('\n')
  const rules: string[] = []
  for (const m of css.matchAll(/p\.(docx-num-[\w-]+) \{[^}]*?text-indent: -([\d.]+pt)/g)) {
    rules.push(`p.${m[1]}::before { display: inline-block; min-width: ${m[2]}; text-indent: 0; }`)
  }
  for (const style of styles) {
    const text = style.textContent ?? ''
    if (text.includes('docx-num-')) style.textContent = text.replace(/\\9"/g, '"')
  }
  if (rules.length) {
    const extra = document.createElement('style')
    extra.textContent = rules.join('\n')
    root.append(extra)
  }
}

/**
 * Word computes which rows and columns of a styled table are the header,
 * first column and stripes; files often don't record it per cell, and
 * docx-preview then draws the table plain. Mark them the way Word would.
 */
function fixTableBands(root: ShadowRoot) {
  const marks = ['first-row', 'last-row', 'first-col', 'last-col', 'odd-row', 'even-row', 'odd-col', 'even-col']
  for (const table of root.querySelectorAll('table')) {
    const rows = [...table.rows]
    if (rows.some((tr) => marks.some((m) => tr.classList.contains(m) || [...tr.cells].some((td) => td.classList.contains(m)))))
      continue
    const has = (m: string) => table.classList.contains(m)
    rows.forEach((tr, i) => {
      const header = has('first-row') && i === 0
      const footer = has('last-row') && i === rows.length - 1 && rows.length > 1
      if (header) tr.classList.add('first-row')
      if (footer) tr.classList.add('last-row')
      if (!header && !footer) tr.classList.add((i - (has('first-row') ? 1 : 0)) % 2 === 0 ? 'odd-row' : 'even-row')
      const cells = [...tr.cells]
      cells.forEach((td, j) => {
        const first = has('first-col') && j === 0
        const last = has('last-col') && j === cells.length - 1 && cells.length > 1
        if (first) td.classList.add('first-col')
        if (last) td.classList.add('last-col')
        if (!first && !last) td.classList.add((j - (has('first-col') ? 1 : 0)) % 2 === 0 ? 'odd-col' : 'even-col')
      })
    })
  }
}

/**
 * Paragraph styles with "Don't add space between paragraphs of the same
 * style" (lists, mostly). docx-preview ignores the setting, so do what Word does.
 */
async function fixContextualSpacing(blob: Blob, body: HTMLElement) {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(blob)
  const xml = await zip.file('word/styles.xml')?.async('string')
  if (!xml) return
  const ids = new Set<string>()
  for (const m of xml.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    if (/<w:contextualSpacing(?:\s+w:val="(?:1|true|on)")?\s*\/>/.test(m[2])) ids.add(`docx_${m[1].toLowerCase()}`)
  }
  if (!ids.size) return
  const styleOf = (el: Element | null) =>
    el?.tagName === 'P' ? [...el.classList].find((c) => ids.has(c)) : undefined
  for (const p of body.querySelectorAll<HTMLElement>('section.docx p')) {
    const style = styleOf(p)
    if (!style) continue
    if (styleOf(p.nextElementSibling) === style) p.style.marginBottom = '0'
    if (styleOf(p.previousElementSibling) === style) p.style.marginTop = '0'
  }
}

/**
 * docx-preview gives the default paragraph style's fonts only to paragraphs
 * that name it, but Word applies it to every paragraph that names no style.
 */
function applyDefaultStyle(root: ShadowRoot, body: HTMLElement) {
  const css = [...root.querySelectorAll('style')].map((s) => s.textContent).join('\n')
  const name = /\.docx p,\s*p\.([\w-]+) span/.exec(css)?.[1]
  if (!name) return
  for (const p of body.querySelectorAll('section.docx p')) {
    if (![...p.classList].some((c) => c.startsWith('docx_'))) p.classList.add(name)
  }
}

// The document gets its own box (a shadow root), so none of the app's styles
// or its dark theme reach it and it looks the way Word lays it out.
const WORD_CSS = `
:host { all: initial; display: block; color: #000; color-scheme: light; }
.frame { width: max-content; min-width: 100%; }
.docx-wrapper { background: #e8e8e8 !important; padding: 16px !important; }
.docx-wrapper > section.docx { margin-bottom: 16px !important; box-shadow: 0 1px 4px rgb(0 0 0 / 0.3) !important; }
.docx-wrapper > section.docx:last-child { margin-bottom: 0 !important; }
a { color: inherit; }
`

function WordView({ blob, zoom, onZoom, onProblem }: ViewProps & { blob: Blob }) {
  const box = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement | null>(null)
  const [naturalWidth, setNaturalWidth] = useState(0)
  const [ready, setReady] = useState(false)
  const used = useFitZoom(box, naturalWidth, zoom, onZoom)

  useEffect(() => {
    const el = host.current
    if (!el) return
    let cancelled = false
    const root = el.shadowRoot ?? el.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = WORD_CSS
    const body = document.createElement('div')
    body.className = 'frame'
    root.replaceChildren(style, body)
    frame.current = body
    import('docx-preview')
      .then(({ renderAsync }) =>
        renderAsync(blob, body, body, {
          className: 'docx',
          inWrapper: true,
          breakPages: true,
          // Keep the page breaks Word last laid out, so pages match the original.
          ignoreLastRenderedPageBreak: false,
          // Tab stops (tables of contents, aligned fields) laid out like Word.
          experimental: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          renderComments: false,
          renderChanges: false,
          renderAltChunks: false,
          useBase64URL: true,
        }),
      )
      .then(() => {
        if (cancelled) return
        tidyLinks(root)
        fixSymbols(root)
        applyDefaultStyle(root, body)
        fixListTabs(root)
        fixTableBands(root)
        return fixContextualSpacing(blob, body).catch(() => undefined)
      })
      .then(() => {
        if (cancelled) return
        const pages = [...body.querySelectorAll<HTMLElement>('section.docx')]
        setNaturalWidth(Math.max(0, ...pages.map((p) => p.offsetWidth)) + 32)
        setReady(true)
      })
      .catch((error: unknown) => {
        if (!cancelled) onProblem(error instanceof Error ? error.message : 'not a Word file it can read')
      })
    return () => {
      cancelled = true
      root.replaceChildren()
    }
  }, [blob, onProblem])

  useEffect(() => {
    if (frame.current) frame.current.style.setProperty('zoom', String(used))
  }, [used, ready])

  return (
    <div ref={box} className="preview-paged">
      {!ready && (
        <p className="muted" role="status">
          Laying out the document…
        </p>
      )}
      <div ref={host} className="preview-word" />
    </div>
  )
}

const HEADER_WIDTH = 40
const HEADER_HEIGHT = 20

function ExcelView({ workbook, zoom, onZoom }: ViewProps & { workbook: ViewWorkbook }) {
  const [index, setIndex] = useState(workbook.active)
  const box = useRef<HTMLDivElement>(null)
  const sheet: ViewSheet | undefined = workbook.sheets[index] ?? workbook.sheets[0]
  const width = HEADER_WIDTH + (sheet?.columns.reduce((sum, c) => sum + c.width, 0) ?? 0)
  const used = useFitZoom(box, width, zoom, onZoom)
  if (!sheet) return <p className="muted">This workbook has no sheets to show.</p>
  return (
    <div className="xl">
      <div ref={box} className="xl-scroll">
        {sheet.rows.length === 0 ? (
          <p className="muted xl-empty">This sheet is empty.</p>
        ) : (
          <div className="xl-sheet" style={{ zoom: used } as CSSProperties}>
            <table className="xl-grid" aria-label={sheet.name} style={{ width }}>
              <colgroup>
                <col style={{ width: HEADER_WIDTH }} />
                {sheet.columns.map((c) => (
                  <col key={c.letter} style={{ width: c.width }} />
                ))}
              </colgroup>
              <thead>
                <tr style={{ height: HEADER_HEIGHT }}>
                  <th className="xl-corner" />
                  {sheet.columns.map((c) => (
                    <th key={c.letter} scope="col">
                      {c.letter}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sheet.rows.map((row) => (
                  <tr key={row.number} style={{ height: row.height }}>
                    <th scope="row">{row.number}</th>
                    {row.cells.map((cell) => (
                      <td
                        key={cell.col}
                        colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                        rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                        style={cell.style as CSSProperties}
                      >
                        {cell.runs
                          ? cell.runs.map((run, i) => (
                              <span key={i} style={run.style as CSSProperties}>
                                {run.text}
                              </span>
                            ))
                          : cell.text}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {sheet.images.map((image, i) => (
              <img
                key={i}
                className="xl-image"
                src={image.src}
                alt=""
                style={{
                  left: HEADER_WIDTH + image.left,
                  top: HEADER_HEIGHT + image.top,
                  width: image.width,
                  height: image.height,
                }}
              />
            ))}
          </div>
        )}
      </div>
      {sheet.cut && <small className="muted">Only part of this sheet is shown. Download the file for the rest.</small>}
      {workbook.sheets.length > 1 && (
        <div className="xl-tabs" role="tablist" aria-label="Sheets">
          {workbook.sheets.map((s, i) => (
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
    </div>
  )
}

/** PDF pages drawn by pdf.js, so they look the same in every browser and in the iPhone app. */
function PdfView({ data, name, zoom, onZoom, onProblem }: ViewProps & { data: ArrayBuffer; name: string }) {
  const box = useRef<HTMLDivElement>(null)
  const pagesRef = useRef<HTMLDivElement>(null)
  const [doc, setDoc] = useState<import('pdfjs-dist').PDFDocumentProxy | null>(null)
  const [naturalWidth, setNaturalWidth] = useState(0)
  const used = useFitZoom(box, naturalWidth, zoom, onZoom, 32)

  useEffect(() => {
    let cancelled = false
    let task: import('pdfjs-dist').PDFDocumentLoadingTask | null = null
    ;(async () => {
      const [pdfjs, worker] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ])
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default
      // A copy: pdf.js takes ownership of the bytes it is given.
      task = pdfjs.getDocument({ data: data.slice(0) })
      const opened = await task.promise
      const first = await opened.getPage(1)
      if (cancelled) return
      setNaturalWidth(first.getViewport({ scale: 96 / 72 }).width + 32)
      setDoc(opened)
    })().catch((error: unknown) => {
      if (!cancelled) onProblem(error instanceof Error ? error.message : 'not a PDF it can read')
    })
    return () => {
      cancelled = true
      void task?.destroy()
    }
  }, [data, onProblem])

  const draw = useCallback(
    async (scale: number, isCancelled: () => boolean) => {
      const holder = pagesRef.current
      if (!doc || !holder) return
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const count = Math.min(doc.numPages, MAX_PAGES)
      const canvases: HTMLCanvasElement[] = []
      for (let n = 1; n <= count; n++) {
        const page = await doc.getPage(n)
        if (isCancelled()) return
        const viewport = page.getViewport({ scale: (96 / 72) * scale })
        const canvas = document.createElement('canvas')
        canvas.className = 'pdf-page'
        canvas.width = Math.floor(viewport.width * ratio)
        canvas.height = Math.floor(viewport.height * ratio)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        canvas.setAttribute('aria-label', `Page ${n} of ${doc.numPages}`)
        canvas.setAttribute('role', 'img')
        canvases.push(canvas)
        if (n === 1) holder.replaceChildren(canvas)
        else holder.append(canvas)
        await page.render({
          canvas,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        }).promise
        if (isCancelled()) return
      }
    },
    [doc],
  )

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      void draw(used, () => cancelled).catch((error: unknown) => {
        if (!cancelled) onProblem(error instanceof Error ? error.message : 'could not draw the pages')
      })
    }, 60)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [draw, used, onProblem])

  return (
    <div ref={box} className="preview-paged">
      {!doc && (
        <p className="muted" role="status">
          Opening the PDF…
        </p>
      )}
      <div ref={pagesRef} className="pdf-pages" aria-label={name} />
      {doc && doc.numPages > MAX_PAGES && (
        <small className="muted">
          Showing the first {MAX_PAGES} of {doc.numPages} pages. Download the file for the rest.
        </small>
      )}
    </div>
  )
}

function CsvView({ rows, name }: { rows: string[][]; name: string }) {
  if (rows.length === 0) return <p className="muted">This file is empty.</p>
  const width = Math.max(0, ...rows.slice(0, MAX_ROWS).map((r) => r.length))
  return (
    <>
      <div className="preview-table-wrap">
        <table className="preview-table" aria-label={name}>
          <tbody>
            {rows.slice(0, MAX_ROWS).map((row, r) => (
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
      {rows.length > MAX_ROWS && (
        <small className="muted">
          Showing the first {MAX_ROWS} of {rows.length} rows. Download the file for the rest.
        </small>
      )}
    </>
  )
}
