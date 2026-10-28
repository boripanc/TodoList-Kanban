// Files attached to cards, such as interface specs in Word or Excel. Shared by
// the app and the server, which stores them in Postgres (kanban.attachments).

/** Largest file a card can take. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024

/** File types that can be attached, by extension, with the type the server serves them as. */
export const attachmentTypes: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  xls: 'application/vnd.ms-excel',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  csv: 'text/csv',
  txt: 'text/plain',
  xml: 'application/xml',
  xsd: 'application/xml',
  wsdl: 'application/xml',
  json: 'application/json',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
}

/** What the file picker offers. */
export const attachmentAccept = Object.keys(attachmentTypes)
  .map((ext) => `.${ext}`)
  .join(',')

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** Why a file can't be attached, or null when it can. */
export function attachmentProblem(name: string, size: number): string | null {
  if (!name.trim()) return 'The file needs a name.'
  if (!attachmentTypes[extensionOf(name)])
    return `${name}: only Word, Excel, PowerPoint, PDF, CSV, text, XML/XSD/WSDL, JSON, ZIP and images can be attached.`
  if (size === 0) return `${name} is empty.`
  if (size > ATTACHMENT_MAX_BYTES) return `${name} is larger than ${formatSize(ATTACHMENT_MAX_BYTES)}.`
  return null
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`
}

/** A small icon for the file's kind. */
export function attachmentIcon(name: string): string {
  const ext = extensionOf(name)
  if (ext.startsWith('doc')) return '📝'
  if (ext.startsWith('xls') || ext === 'csv') return '📊'
  if (ext === 'pptx') return '📽'
  if (ext === 'pdf') return '📕'
  if (['png', 'jpg', 'jpeg'].includes(ext)) return '🖼'
  return '📄'
}
