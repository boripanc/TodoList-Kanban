// Turns an Excel workbook (read by ExcelJS) into what the file viewer draws:
// column widths, row heights, merged cells, fonts, fills, borders, number
// formats and pictures, so a sheet looks the way it does in Excel.
import type { Workbook, Worksheet, Cell, Color, Border, Fill, Font, Alignment } from 'exceljs'

/** Most rows and columns drawn; the rest are in the download. */
export const SHEET_MAX_ROWS = 2000
export const SHEET_MAX_COLS = 200

export interface CellStyle {
  [property: string]: string | undefined
}

export interface ViewCell {
  /** Zero-based column in the sheet. */
  col: number
  text: string
  /** Rich text keeps each run's own font. */
  runs?: { text: string; style: CellStyle }[]
  style: CellStyle
  colSpan: number
  rowSpan: number
}

export interface ViewRow {
  /** One-based row number, as Excel shows it. */
  number: number
  height: number
  cells: ViewCell[]
}

export interface ViewImage {
  src: string
  left: number
  top: number
  width: number
  height: number
}

export interface ViewSheet {
  name: string
  /** Column letters and widths in pixels, for the visible columns. */
  columns: { letter: string; width: number }[]
  rows: ViewRow[]
  images: ViewImage[]
  gridLines: boolean
  /** Rows or columns past the limits were left out. */
  cut: boolean
}

export interface ViewWorkbook {
  sheets: ViewSheet[]
  /** The sheet Excel had open. */
  active: number
}

const GRID = '1px solid #d4d4d4'
const DEFAULT_THEME = [
  'FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '0563C1', '954F72',
]
// The legacy 64-colour palette that "indexed" colours point into.
const INDEXED = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '000000', 'FFFFFF', 'FF0000', '00FF00',
  '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF', '000080', 'FF00FF', 'FFFF00', '00FFFF',
  '800080', '800000', '008080', '0000FF', '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696', '003366', '339966', '003300', '333300',
  '993300', '993366', '333399', '333333',
]

export function columnLetter(index: number): string {
  let n = index + 1
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** The workbook's theme colours, in the order Excel's theme indexes use. */
export function themeColors(themeXml: string | undefined): string[] {
  if (!themeXml) return DEFAULT_THEME
  const scheme = /<a:clrScheme[\s\S]*?<\/a:clrScheme>/.exec(themeXml)?.[0]
  if (!scheme) return DEFAULT_THEME
  const pick = (tag: string) => {
    const block = new RegExp(`<a:${tag}>([\\s\\S]*?)</a:${tag}>`).exec(scheme)?.[1] ?? ''
    return /lastClr="([0-9A-Fa-f]{6})"/.exec(block)?.[1] ?? /srgbClr val="([0-9A-Fa-f]{6})"/.exec(block)?.[1]
  }
  const order = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']
  return order.map((tag, i) => (pick(tag) ?? DEFAULT_THEME[i]).toUpperCase())
}

/** Lighten (tint > 0) or darken (tint < 0) a colour the way Excel does. */
export function applyTint(hex: string, tint: number): string {
  if (!tint) return hex
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0
  let s = 0
  let l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    h /= 6
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  let out: number[]
  if (s === 0) out = [l, l, l]
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    out = [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)]
  }
  return out.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()
}

type AnyColor = Partial<Color> & { indexed?: number; tint?: number }

export function cssColor(color: AnyColor | undefined, theme: string[]): string | undefined {
  if (!color) return undefined
  let hex: string | undefined
  if (color.argb) {
    hex = color.argb.length === 8 ? color.argb.slice(2) : color.argb
  } else if (color.theme !== undefined) hex = theme[color.theme]
  else if (color.indexed !== undefined) {
    if (color.indexed === 64) return undefined // "system foreground": the default
    hex = INDEXED[color.indexed]
  }
  if (!hex || !/^[0-9A-Fa-f]{6}$/.test(hex)) return undefined
  return `#${applyTint(hex.toUpperCase(), color.tint ?? 0)}`
}

// --- Number formats ---

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Excel's built-in formats that files refer to by number only. */
const BUILT_IN: Record<string, string> = {
  '14': 'm/d/yyyy',
  '22': 'm/d/yyyy h:mm',
}

function formatDate(date: Date, fmt: string): string {
  const tokens = fmt.match(/yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|am\/pm|a\/p|"[^"]*"|\\.|./gi) ?? []
  const ampm = tokens.some((t) => /^(am\/pm|a\/p)$/i.test(t))
  const hours = date.getUTCHours()
  const out: string[] = []
  tokens.forEach((token, i) => {
    const lower = token.toLowerCase()
    // "m" right after an hour or right before seconds means minutes.
    const prev = tokens.slice(0, i).reverse().find((t) => /[a-z]/i.test(t) && !t.startsWith('"'))?.toLowerCase() ?? ''
    const next = tokens.slice(i + 1).find((t) => /[a-z]/i.test(t) && !t.startsWith('"'))?.toLowerCase() ?? ''
    const minutes = (lower === 'm' || lower === 'mm') && (prev.startsWith('h') || next.startsWith('s'))
    if (minutes) out.push(String(date.getUTCMinutes()).padStart(lower.length, '0'))
    else if (lower === 'yyyy') out.push(String(date.getUTCFullYear()))
    else if (lower === 'yy') out.push(String(date.getUTCFullYear()).slice(-2))
    else if (lower === 'mmmm') out.push(MONTHS[date.getUTCMonth()])
    else if (lower === 'mmm') out.push(MONTHS[date.getUTCMonth()].slice(0, 3))
    else if (lower === 'mm') out.push(String(date.getUTCMonth() + 1).padStart(2, '0'))
    else if (lower === 'm') out.push(String(date.getUTCMonth() + 1))
    else if (lower === 'dddd') out.push(DAYS[date.getUTCDay()])
    else if (lower === 'ddd') out.push(DAYS[date.getUTCDay()].slice(0, 3))
    else if (lower === 'dd') out.push(String(date.getUTCDate()).padStart(2, '0'))
    else if (lower === 'd') out.push(String(date.getUTCDate()))
    else if (lower === 'hh' || lower === 'h') {
      const h = ampm ? hours % 12 || 12 : hours
      out.push(lower === 'hh' ? String(h).padStart(2, '0') : String(h))
    } else if (lower === 'ss' || lower === 's') out.push(String(date.getUTCSeconds()).padStart(lower.length, '0'))
    else if (lower === 'am/pm') out.push(hours < 12 ? 'AM' : 'PM')
    else if (lower === 'a/p') out.push(hours < 12 ? 'A' : 'P')
    else if (token.startsWith('"')) out.push(token.slice(1, -1))
    else if (token.startsWith('\\')) out.push(token.slice(1))
    else out.push(token)
  })
  return out.join('')
}

function general(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e11) return String(n)
  const abs = Math.abs(n)
  if (abs !== 0 && (abs >= 1e11 || abs < 1e-9)) return n.toExponential(5).replace(/\.?0+e/, 'E').replace('E+', 'E+')
  return String(parseFloat(n.toPrecision(10)))
}

function formatNumber(n: number, section: string): string {
  // Literal text, escapes, padding and colours.
  let fmt = section.replace(/\[[^\]]*\]/g, (m) => {
    const currency = /^\[\$([^-\]]*)/.exec(m)
    return currency ? `"${currency[1]}"` : ''
  })
  fmt = fmt.replace(/_./g, ' ').replace(/\*./g, '')
  const literals: string[] = []
  fmt = fmt.replace(/"([^"]*)"|\\(.)/g, (_, quoted: string | undefined, escaped: string | undefined) => {
    literals.push(quoted ?? escaped ?? '')
    return `\uf8ff${String.fromCharCode(0xe000 + literals.length - 1)}`
  })
  if (/^\s*@\s*$/.test(fmt)) return String(n)
  const placeholder = /[0#?][0#?,.]*(?:[eE][+-][0#]+)?%?/.exec(fmt)
  if (!placeholder) return fmt.replace(/\uf8ff([\ue000-\uf8fe])/g, (_, ch: string) => literals[ch.charCodeAt(0) - 0xe000])
  let value = Math.abs(n)
  const percents = (fmt.match(/%/g) ?? []).length
  value *= 100 ** percents
  const pattern = placeholder[0].replace(/%/g, '')
  let body: string
  const exp = /[eE][+-]/.exec(pattern)
  if (exp) {
    const decimals = (pattern.split(/[eE]/)[0].split('.')[1] ?? '').length
    body = value.toExponential(decimals).toUpperCase().replace(/E([+-])(\d)$/, 'E$10$2')
  } else {
    // Commas after the last digit divide by 1000 each.
    const trailing = /,+$/.exec(pattern.split('.')[0])?.[0].length ?? 0
    value /= 1000 ** trailing
    const [intPart, decPart = ''] = pattern.replace(/,+$/, '').split('.')
    const minDec = (decPart.match(/0/g) ?? []).length
    const maxDec = decPart.replace(/,/g, '').length
    let fixed = value.toFixed(maxDec)
    if (maxDec > minDec) fixed = fixed.replace(new RegExp(`0{1,${maxDec - minDec}}$`), '').replace(/\.$/, '')
    let [whole, frac] = fixed.split('.')
    const minInt = (intPart.match(/0/g) ?? []).length
    if (whole === '0' && minInt === 0) whole = ''
    whole = whole.padStart(minInt, '0')
    if (intPart.includes(',')) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    body = frac !== undefined ? `${whole}.${frac}` : whole
  }
  body += '%'.repeat((placeholder[0].match(/%/g) ?? []).length)
  const out = fmt.slice(0, placeholder.index) + body + fmt.slice(placeholder.index + placeholder[0].length)
  return out.replace(/\uf8ff([\ue000-\uf8fe])/g, (_, ch: string) => literals[ch.charCodeAt(0) - 0xe000])
}

/** A cell value as Excel shows it with the given number format. */
export function formatValue(value: unknown, numFmt: string | undefined): string {
  if (value === null || value === undefined) return ''
  const fmt = BUILT_IN[numFmt ?? ''] ?? numFmt ?? 'General'
  if (value instanceof Date) {
    if (fmt === 'General' || !/[dmyhs]/i.test(fmt.replace(/"[^"]*"/g, '')))
      return formatDate(value, value.getUTCHours() || value.getUTCMinutes() ? 'm/d/yyyy h:mm' : 'm/d/yyyy')
    return formatDate(value, fmt.split(';')[0].replace(/\[[^\]]*\]/g, ''))
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value !== 'number') return String(value)
  if (fmt === 'General' || fmt === '') return general(value)
  const sections = fmt.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/)
  let section = sections[0]
  if (value < 0 && sections[1] !== undefined) section = sections[1]
  else if (value === 0 && sections[2] !== undefined) section = sections[2]
  const text = formatNumber(value, section)
  return value < 0 && (sections[1] === undefined || !sections[1].trim()) && !text.startsWith('-') ? `-${text}` : text
}

// --- Styles ---

const borderCss: Record<string, string> = {
  thin: '1px solid',
  hair: '1px dotted',
  dotted: '1px dotted',
  dashed: '1px dashed',
  dashDot: '1px dashed',
  dashDotDot: '1px dotted',
  slantDashDot: '2px dashed',
  medium: '2px solid',
  mediumDashed: '2px dashed',
  mediumDashDot: '2px dashed',
  mediumDashDotDot: '2px dashed',
  thick: '3px solid',
  double: '3px double',
}

function border(b: Partial<Border> | undefined, theme: string[]): string | undefined {
  if (!b?.style || !borderCss[b.style]) return undefined
  return `${borderCss[b.style]} ${cssColor(b.color as AnyColor, theme) ?? '#000000'}`
}

export function fontCss(font: Partial<Font> | undefined, theme: string[]): CellStyle {
  if (!font) return {}
  const style: CellStyle = {}
  if (font.name) style.fontFamily = `"${font.name}", Calibri, Carlito, Arial, sans-serif`
  if (font.size) style.fontSize = `${font.size}pt`
  if (font.bold) style.fontWeight = '700'
  if (font.italic) style.fontStyle = 'italic'
  const lines = [font.underline && font.underline !== 'none' ? 'underline' : '', font.strike ? 'line-through' : ''].filter(Boolean)
  if (lines.length) style.textDecoration = lines.join(' ')
  if (font.underline === 'double' || font.underline === 'doubleAccounting') style.textDecorationStyle = 'double'
  if (font.vertAlign === 'superscript') style.verticalAlign = 'super'
  if (font.vertAlign === 'subscript') style.verticalAlign = 'sub'
  const color = cssColor(font.color as AnyColor, theme)
  if (color) style.color = color
  return style
}

function fillCss(fill: Fill | undefined, theme: string[]): string | undefined {
  if (!fill) return undefined
  if (fill.type === 'pattern') {
    if (fill.pattern === 'none') return undefined
    return cssColor(fill.fgColor as AnyColor, theme) ?? cssColor(fill.bgColor as AnyColor, theme)
  }
  if (fill.type === 'gradient') return cssColor(fill.stops?.[0]?.color as AnyColor, theme)
  return undefined
}

function alignCss(alignment: Partial<Alignment> | undefined, value: unknown): CellStyle {
  const style: CellStyle = {}
  const h = alignment?.horizontal
  const numeric = typeof value === 'number' || value instanceof Date
  style.textAlign =
    h === 'center' || h === 'centerContinuous' ? 'center' : h === 'right' ? 'right' : h === 'justify' || h === 'distributed' ? 'justify' : h === 'left' || h === 'fill' ? 'left' : numeric ? 'right' : typeof value === 'boolean' ? 'center' : 'left'
  const v = alignment?.vertical
  style.verticalAlign = v === 'top' ? 'top' : v === 'middle' ? 'middle' : 'bottom'
  if (alignment?.wrapText) style.whiteSpace = 'pre-wrap'
  if (alignment?.indent) style[style.textAlign === 'right' ? 'paddingRight' : 'paddingLeft'] = `${alignment.indent * 9 + 2}px`
  return style
}

/** The value inside a cell: formulas show their result, links their text. */
function cellValue(cell: Cell): unknown {
  const v = cell.value as unknown
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const o = v as Record<string, unknown>
    if ('result' in o) return o.result instanceof Object && 'error' in (o.result as object) ? (o.result as { error: string }).error : o.result
    if ('richText' in o) return (o.richText as { text: string }[]).map((r) => r.text).join('')
    if ('text' in o) return o.text
    if ('error' in o) return o.error
    if ('formula' in o || 'sharedFormula' in o) return ''
  }
  return v
}

const colPx = (width: number | undefined, fallback: number) =>
  width === undefined ? fallback : Math.max(0, Math.round(width * 7 + 5))
const rowPx = (points: number | undefined, fallback: number) => (points === undefined ? fallback : Math.round((points * 4) / 3))

function sheetView(ws: Worksheet, theme: string[], imageUrl: (id: string) => string | undefined): ViewSheet {
  const rowCount = Math.min(ws.rowCount, SHEET_MAX_ROWS)
  const colCount = Math.min(ws.columnCount, SHEET_MAX_COLS)
  const cut = ws.rowCount > SHEET_MAX_ROWS || ws.columnCount > SHEET_MAX_COLS
  const props = ws.properties as { defaultColWidth?: number; defaultRowHeight?: number }
  const defaultCol = colPx(props.defaultColWidth, 64)
  const defaultRow = rowPx(props.defaultRowHeight, 20)
  const gridLines = (ws.views?.[0] as { showGridLines?: boolean } | undefined)?.showGridLines !== false

  const colWidths: number[] = []
  const colHidden: boolean[] = []
  for (let c = 1; c <= colCount; c++) {
    const col = ws.getColumn(c)
    colHidden.push(Boolean(col.hidden))
    colWidths.push(colPx(col.width, defaultCol))
  }

  // Merged ranges: the top-left cell spans, the others are covered.
  const master = new Map<string, { rows: number; cols: number }>()
  const covered = new Set<string>()
  for (const range of (ws.model as { merges?: string[] }).merges ?? []) {
    const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range)
    if (!m) continue
    const toIndex = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)
    const [r1, c1, r2, c2] = [Number(m[2]), toIndex(m[1]), Number(m[4]), toIndex(m[3])]
    master.set(`${r1}:${c1}`, { rows: r2 - r1 + 1, cols: c2 - c1 + 1 })
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (r !== r1 || c !== c1) covered.add(`${r}:${c}`)
  }

  // Each cell draws its right and bottom edge, taking the neighbour's border when it has none.
  const edge = (r: number, c: number, side: 'right' | 'bottom'): string => {
    const own = border(ws.getCell(r, c).border?.[side], theme)
    if (own) return own
    const other = side === 'right' ? ws.getCell(r, c + 1).border?.left : ws.getCell(r + 1, c).border?.top
    return border(other, theme) ?? (gridLines ? GRID : 'none')
  }

  const rows: ViewRow[] = []
  const rowTops: number[] = []
  let top = 0
  for (let r = 1; r <= rowCount; r++) {
    const row = ws.getRow(r)
    const height = rowPx(row.height, defaultRow)
    rowTops.push(top)
    if (row.hidden) continue
    top += height
    const cells: ViewCell[] = []
    for (let c = 1; c <= colCount; c++) {
      if (colHidden[c - 1] || covered.has(`${r}:${c}`)) continue
      const cell = ws.getCell(r, c)
      const span = master.get(`${r}:${c}`) ?? { rows: 1, cols: 1 }
      const lastCol = Math.min(colCount, c + span.cols - 1)
      const lastRow = Math.min(rowCount, r + span.rows - 1)
      const value = cellValue(cell)
      const style: CellStyle = {
        ...fontCss(cell.font, theme),
        ...alignCss(cell.alignment, value),
        borderRight: edge(r, lastCol, 'right'),
        borderBottom: edge(lastRow, c, 'bottom'),
      }
      const background = fillCss(cell.fill, theme)
      if (background) style.backgroundColor = background
      const raw = cell.value as { richText?: { text: string; font?: Partial<Font> }[] } | null
      const runs = raw && typeof raw === 'object' && 'richText' in raw ? raw.richText : undefined
      let colSpan = 0
      for (let k = c; k <= lastCol; k++) if (!colHidden[k - 1]) colSpan++
      cells.push({
        col: c - 1,
        text: formatValue(value, cell.numFmt),
        runs: runs?.map((run) => ({ text: run.text, style: fontCss(run.font, theme) })),
        style,
        colSpan: Math.max(1, colSpan),
        rowSpan: Math.max(1, lastRow - r + 1),
      })
    }
    rows.push({ number: r, height, cells })
  }

  // Pictures, placed by the cell they start in plus the offset within it.
  const images: ViewImage[] = []
  const left = (col: number) => {
    const whole = Math.floor(col)
    let x = 0
    for (let i = 0; i < whole && i < colWidths.length; i++) if (!colHidden[i]) x += colWidths[i]
    return x + (col - whole) * (colWidths[whole] ?? defaultCol)
  }
  const topOf = (row: number) => {
    const whole = Math.floor(row)
    const base = rowTops[whole] ?? top
    const h = rowPx(ws.getRow(whole + 1).height, defaultRow)
    return base + (row - whole) * h
  }
  for (const image of ws.getImages()) {
    const src = imageUrl(String(image.imageId))
    const range = image.range as unknown as {
      tl: { nativeCol?: number; nativeRow?: number; col: number; row: number }
      br?: { col: number; row: number }
      ext?: { width: number; height: number }
    }
    if (!src || !range?.tl) continue
    const x = left(range.tl.col)
    const y = topOf(range.tl.row)
    const width = range.ext ? range.ext.width : range.br ? left(range.br.col) - x : 0
    const height = range.ext ? range.ext.height : range.br ? topOf(range.br.row) - y : 0
    if (width > 0 && height > 0) images.push({ src, left: x, top: y, width, height })
  }

  return {
    name: ws.name,
    columns: colWidths.flatMap((width, i) => (colHidden[i] ? [] : [{ letter: columnLetter(i), width }])),
    rows,
    images,
    gridLines,
    cut,
  }
}

/**
 * The visible sheets of a workbook, ready to draw. `imageUrl` turns a picture
 * (by ExcelJS image id) into a URL; the caller owns and frees those URLs.
 */
export function workbookView(wb: Workbook, imageUrl: (id: string) => string | undefined): ViewWorkbook {
  const theme = themeColors((wb.model as unknown as { themes?: Record<string, string> }).themes?.theme1)
  const visible = wb.worksheets.filter((ws) => ws.state !== 'hidden' && ws.state !== 'veryHidden')
  const sheets = visible.map((ws) => sheetView(ws, theme, imageUrl))
  const activeTab = (wb.views?.[0] as { activeTab?: number } | undefined)?.activeTab ?? 0
  const activeSheet = wb.worksheets[activeTab]
  const active = Math.max(0, visible.indexOf(activeSheet))
  return { sheets, active }
}
