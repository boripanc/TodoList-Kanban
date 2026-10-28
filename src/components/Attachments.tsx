import { useRef, useState } from 'react'
import type { Board, Card } from '../types'
import type { Attachment } from '../cloud/api'
import { useCloud } from '../cloud/context'
import {
  attachmentAccept,
  attachmentCategories,
  attachmentIcon,
  categoryName,
  formatSize,
  previewKind,
  type AttachmentCategory,
} from '../lib/attachments'
import { FilePreview } from './FilePreview'

/**
 * An attached file's name: opens it in the app when the browser can show it
 * (Word, Excel, PDF, images, text), otherwise downloads it.
 */
export function AttachmentLink({ file }: { file: Attachment }) {
  const cloud = useCloud()
  const [viewing, setViewing] = useState(false)
  if (!cloud) return null
  const label = (
    <>
      <span aria-hidden>{attachmentIcon(file.name)}</span> {file.name}
    </>
  )
  if (!previewKind(file.name)) {
    return (
      <a className="attachment-link" href={cloud.api.attachmentUrl(file.id)} download={file.name}>
        {label}
      </a>
    )
  }
  return (
    <>
      <button
        type="button"
        className="attachment-link link-button"
        aria-label={`View ${file.name}`}
        onClick={() => setViewing(true)}
      >
        {label}
      </button>
      {viewing && <FilePreview file={file} onClose={() => setViewing(false)} />}
    </>
  )
}

const sectionHint: Record<AttachmentCategory, string> = {
  technical: 'iFlow design, adapters, security, error handling',
  mapping: 'Field mapping, value mapping, sample messages',
  other: 'Anything else, e.g. test evidence or WSDL/XSD',
}

/**
 * Files on a card. Interface cards get a section each for the technical spec,
 * the mapping spec and other files; other cards get one list.
 */
export function CardFiles({ board, card, readOnly }: { board: Board; card: Card; readOnly: boolean }) {
  const cloud = useCloud()
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
  const alert = problem && (
    <small className="date-warning" role="alert">
      ⚠ {problem}
    </small>
  )

  if (!card.spec) {
    return (
      <div className="field">
        <span>Files {files.length > 0 && `(${files.length})`}</span>
        <FileSection cardId={card.id} files={files} category="other" readOnly={readOnly} onProblem={setProblem} />
        {alert}
      </div>
    )
  }
  return (
    <div className="field spec-files">
      <span>Spec files</span>
      {attachmentCategories.map((category) => {
        const mine = files.filter((f) => f.category === category)
        return (
          <section key={category} className="spec-file-section" aria-label={categoryName[category]}>
            <h4>
              {categoryName[category]} {mine.length > 0 && <small className="muted">({mine.length})</small>}
            </h4>
            <FileSection
              cardId={card.id}
              files={mine}
              category={category}
              readOnly={readOnly}
              movable
              onProblem={setProblem}
            />
          </section>
        )
      })}
      {alert}
    </div>
  )
}

function FileSection({
  cardId,
  files,
  category,
  readOnly,
  movable = false,
  onProblem,
}: {
  cardId: string
  files: Attachment[]
  category: AttachmentCategory
  readOnly: boolean
  movable?: boolean
  onProblem: (problem: string | null) => void
}) {
  const cloud = useCloud()!
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const what = movable ? categoryName[category].toLowerCase() : 'files'

  const upload = async (list: FileList | null) => {
    if (!list?.length) return
    setBusy(true)
    onProblem(null)
    try {
      for (const file of Array.from(list)) await cloud.addAttachment(cardId, file, category)
    } catch (error) {
      onProblem(error instanceof Error ? error.message : 'Could not attach that file.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {files.length > 0 && (
        <ul className="attachment-list" aria-label={movable ? `${categoryName[category]} files` : 'Attached files'}>
          {files.map((file) => (
            <li key={file.id}>
              <AttachmentLink file={file} />
              <small className="muted">
                {formatSize(file.size)}
                {file.uploadedBy && ` · ${file.uploadedBy}`} · {new Date(file.uploadedAt).toLocaleDateString()}
              </small>
              <span className="attachment-actions">
                <a
                  className="icon-button"
                  href={cloud.api.attachmentUrl(file.id)}
                  download={file.name}
                  aria-label={`Download ${file.name}`}
                  title="Download"
                >
                  ⬇
                </a>
                {!readOnly && movable && (
                  <select
                    className="attachment-move"
                    aria-label={`Section for ${file.name}`}
                    value={file.category}
                    onChange={(e) =>
                      void cloud
                        .setAttachmentCategory(file.id, e.target.value as AttachmentCategory)
                        .catch(cloud.reportError)
                    }
                  >
                    {attachmentCategories.map((c) => (
                      <option key={c} value={c}>
                        {categoryName[c]}
                      </option>
                    ))}
                  </select>
                )}
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
              </span>
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
            aria-label={movable ? `Choose ${what} files` : 'Choose files to attach'}
            onChange={(e) => {
              const list = e.target.files
              void upload(list).finally(() => {
                e.target.value = ''
              })
            }}
          />
          <button
            type="button"
            className={movable ? 'button small-button' : 'button'}
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? 'Uploading…' : movable ? `📎 Upload ${what}` : '📎 Attach Word, Excel or PDF'}
          </button>
          <small className="muted attachment-hint">
            {movable ? `${sectionHint[category]}. ` : ''}Up to 10 MB each: Word, Excel, PDF, XML, XSD, WSDL, JSON, CSV,
            ZIP or images.
          </small>
        </div>
      )}
      {readOnly && files.length === 0 && <small className="muted">No files.</small>}
    </>
  )
}
