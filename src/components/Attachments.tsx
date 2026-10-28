import { useRef, useState } from 'react'
import type { Board, Card } from '../types'
import type { Attachment } from '../cloud/api'
import { useCloud } from '../cloud/context'
import { attachmentAccept, attachmentIcon, formatSize } from '../lib/attachments'

/** A download link for an attached file. */
export function AttachmentLink({ file }: { file: Attachment }) {
  const cloud = useCloud()
  if (!cloud) return null
  return (
    <a className="attachment-link" href={cloud.api.attachmentUrl(file.id)} download={file.name}>
      <span aria-hidden>{attachmentIcon(file.name)}</span> {file.name}
    </a>
  )
}

/** Files on a card, such as its spec in Word or Excel: list, download, attach and remove. */
export function CardFiles({ board, card, readOnly }: { board: Board; card: Card; readOnly: boolean }) {
  const cloud = useCloud()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  if (!cloud?.user) return null
  if (!board.cloud) {
    return (
      <div className="field">
        <span>Files</span>
        <small className="muted">
          Files can be attached on boards in your account. Use Share board… to move this board there.
        </small>
      </div>
    )
  }
  const files = cloud.attachments.filter((a) => a.cardId === card.id)

  const upload = async (list: FileList | null) => {
    if (!list?.length) return
    setBusy(true)
    setProblem(null)
    try {
      for (const file of Array.from(list)) await cloud.addAttachment(card.id, file)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Could not attach that file.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="field">
      <span>Files {files.length > 0 && `(${files.length})`}</span>
      {files.length > 0 && (
        <ul className="attachment-list" aria-label="Attached files">
          {files.map((file) => (
            <li key={file.id}>
              <AttachmentLink file={file} />
              <small className="muted">
                {formatSize(file.size)}
                {file.uploadedBy && ` · ${file.uploadedBy}`} · {new Date(file.uploadedAt).toLocaleDateString()}
              </small>
              {!readOnly && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => {
                    if (window.confirm(`Remove ${file.name} from this card?`)) {
                      void cloud.deleteAttachment(file.id).catch(cloud.reportError)
                    }
                  }}
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <div>
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            accept={attachmentAccept}
            aria-label="Choose files to attach"
            onChange={(e) => {
              const list = e.target.files
              void upload(list).finally(() => {
                e.target.value = ''
              })
            }}
          />
          <button type="button" className="button" disabled={busy} onClick={() => inputRef.current?.click()}>
            {busy ? 'Attaching…' : '📎 Attach Word, Excel or PDF'}
          </button>
          <small className="muted attachment-hint">Up to 10 MB each. Also XML, XSD, WSDL, JSON, CSV, ZIP and images.</small>
        </div>
      )}
      {problem && (
        <small className="date-warning" role="alert">
          ⚠ {problem}
        </small>
      )}
      {readOnly && files.length === 0 && <small className="muted">No files.</small>}
    </div>
  )
}
