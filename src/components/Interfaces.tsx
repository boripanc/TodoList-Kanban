import { useEffect, useRef, useState } from 'react'
import type { AdapterType, Board, Card, InterfaceSpec, MessageMode } from '../types'
import { useStore } from '../state/context'
import { createId } from '../lib/id'
import { isDoneColumn } from '../lib/done'
import {
  adapterGroups,
  adapterName,
  adapterShort,
  listInterfaces,
  messageModes,
  modeName,
  routeText,
  missingSpecFields,
  specFields,
  specsMarkdown,
  specStatuses,
  statusName,
  type InterfaceItem,
} from '../lib/interfaces'
import { Avatar } from './Team'
import { Modal } from './Modal'
import { AttachmentLink } from './Attachments'
import type { Attachment } from '../cloud/api'
import { attachmentCategories, categoryName } from '../lib/attachments'
import { useCloud } from '../cloud/context'

/** Technical spec first, then mapping spec, then other files. */
const sortedFiles = (files: Attachment[]) =>
  [...files].sort((a, b) => attachmentCategories.indexOf(a.category) - attachmentCategories.indexOf(b.category))

type TextKey = (typeof specFields)[number]['key']
type Drafts = Record<TextKey, string>

const draftsOf = (spec: InterfaceSpec): Drafts =>
  Object.fromEntries(specFields.map((f) => [f.key, spec[f.key]])) as Drafts

/** A CPI adapter picker, grouped like the iFlow editor. */
function AdapterSelect({
  value,
  onChange,
  label,
}: {
  value: AdapterType
  onChange: (adapter: AdapterType) => void
  label: string
}) {
  return (
    <select value={value} aria-label={label} onChange={(e) => onChange(e.target.value as AdapterType)}>
      {adapterGroups.map((g) => (
        <optgroup key={g.name} label={g.name}>
          {g.adapters.map((a) => (
            <option key={a} value={a}>
              {adapterName[a]}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

/** The interface spec part of the card dialog: add one, edit it, or take it off. */
export function SpecEditor({ card, readOnly }: { card: Card; readOnly: boolean }) {
  const { dispatch } = useStore()
  const update = (patch: Partial<InterfaceSpec> | null) =>
    dispatch({ type: 'card/updateSpec', cardId: card.id, patch, now: Date.now() })

  if (!card.spec) {
    if (readOnly) return null
    return (
      <div className="field spec-empty">
        <span>Interface spec</span>
        <small className="muted">
          For an integration someone has to build: sender and receiver, CPI adapters, messages and mapping.
        </small>
        <div>
          <button type="button" className="button" onClick={() => update({})}>
            + Add interface spec
          </button>
        </div>
      </div>
    )
  }
  return <SpecFields key={card.id} spec={card.spec} update={update} readOnly={readOnly} />
}

function SpecFields({
  spec,
  update,
  readOnly,
}: {
  spec: InterfaceSpec
  update: (patch: Partial<InterfaceSpec> | null) => void
  readOnly: boolean
}) {
  const [drafts, setDrafts] = useState<Drafts>(() => draftsOf(spec))
  // Typing saves on blur, and when the dialog closes, so Escape never loses it.
  const latest = useRef({ drafts, spec, update })
  useEffect(() => {
    latest.current = { drafts, spec, update }
  })
  const commit = () => {
    const { drafts: d, spec: s, update: u } = latest.current
    const patch: Partial<InterfaceSpec> = {}
    for (const f of specFields) if (d[f.key] !== s[f.key]) patch[f.key] = d[f.key]
    if (Object.keys(patch).length > 0) u(patch)
  }
  useEffect(() => () => commit(), [])

  const missing = missingSpecFields({ ...spec, ...drafts })
  const text = (key: TextKey, hint: string, multiline: boolean, label?: string) =>
    multiline ? (
      <textarea
        className="mono"
        rows={key === 'notes' ? 3 : 4}
        value={drafts[key]}
        placeholder={hint}
        aria-label={label}
        onChange={(e) => setDrafts({ ...drafts, [key]: e.target.value })}
        onBlur={commit}
      />
    ) : (
      <input
        className={key === 'endpoint' ? 'mono' : undefined}
        value={drafts[key]}
        placeholder={hint}
        aria-label={label}
        onChange={(e) => setDrafts({ ...drafts, [key]: e.target.value })}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
    )
  const field = (key: TextKey) => specFields.find((f) => f.key === key)!
  return (
    <section className="spec-editor" aria-label="Interface spec">
      <div className="spec-editor-head">
        <h3>Interface spec</h3>
        <select
          aria-label="Message mode"
          value={spec.mode}
          onChange={(e) => update({ mode: e.target.value as MessageMode })}
        >
          {messageModes.map((m) => (
            <option key={m} value={m}>
              {modeName[m]}
            </option>
          ))}
        </select>
        <select
          aria-label="Spec status"
          className={`spec-status-select spec-${spec.status}`}
          value={spec.status}
          onChange={(e) => update({ status: e.target.value as InterfaceSpec['status'] })}
        >
          {specStatuses.map((st) => (
            <option key={st} value={st}>
              {statusName[st]}
            </option>
          ))}
        </select>
      </div>
      <div className="spec-route">
        <fieldset className="field">
          <legend>Sender</legend>
          {text('senderSystem', field('senderSystem').hint, false, 'Sender system')}
          <AdapterSelect
            label="Sender adapter"
            value={spec.senderAdapter}
            onChange={(senderAdapter) => update({ senderAdapter })}
          />
        </fieldset>
        <fieldset className="field">
          <legend>Receiver</legend>
          {text('receiverSystem', field('receiverSystem').hint, false, 'Receiver system')}
          <AdapterSelect
            label="Receiver adapter"
            value={spec.receiverAdapter}
            onChange={(receiverAdapter) => update({ receiverAdapter })}
          />
        </fieldset>
      </div>
      {(['endpoint', 'notes'] as const).map((key) => (
        <label key={key} className="field">
          <span>{field(key).name}</span>
          {text(key, field(key).hint, key !== 'endpoint')}
        </label>
      ))}
      {spec.status === 'agreed' && missing.length > 0 && (
        <small className="date-warning" role="status">
          ⚠ Agreed, but still empty: {missing.join(', ')}
        </small>
      )}
      {!readOnly && (
        <div>
          <button
            type="button"
            className="button ghost small-button"
            onClick={() => {
              const written = specFields.some((f) => drafts[f.key].trim())
              if (!written || window.confirm('Remove this interface spec? The card stays.')) {
                latest.current.drafts = draftsOf(spec)
                update(null)
              }
            }}
          >
            Remove spec
          </button>
        </div>
      )}
    </section>
  )
}

/** Kind and status of an interface, for the card face and lists. */
export function SpecBadge({ spec }: { spec: InterfaceSpec }) {
  return (
    <span
      className={`badge spec-badge spec-${spec.status}`}
      title={`${routeText(spec)}, ${modeName[spec.mode].toLowerCase()}, spec ${statusName[spec.status].toLowerCase()}`}
    >
      {adapterShort[spec.senderAdapter]} → {adapterShort[spec.receiverAdapter]} · {statusName[spec.status]}
    </span>
  )
}

function downloadMarkdown(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${name.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'board'}-interface-specs.md`
  link.click()
  URL.revokeObjectURL(url)
}

function InterfaceRows({ items, onOpenCard }: { items: InterfaceItem<Card>[]; onOpenCard: (cardId: string) => void }) {
  const cloud = useCloud()
  return (
    <ul className="interface-list">
      {items.map(({ card, column, done }) => (
        <li key={card.id} className={done ? 'is-done' : undefined}>
          <div className="interface-main">
            <button type="button" className="link interface-title" onClick={() => onOpenCard(card.id)}>
              {card.title}
            </button>
            <small className="interface-endpoint">
              {routeText(card.spec)}
              {card.spec.endpoint.trim() && (
                <>
                  {' · '}
                  <code>{card.spec.endpoint.trim()}</code>
                </>
              )}
            </small>
            {cloud?.attachments.some((a) => a.cardId === card.id) && (
              <div className="interface-files" aria-label={`Files for ${card.title}`}>
                {sortedFiles(cloud.attachments.filter((a) => a.cardId === card.id)).map((a) => (
                  <span key={a.id} className="interface-file">
                    {a.category !== 'other' && <small className="muted">{categoryName[a.category]}:</small>}
                    <AttachmentLink file={a} />
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="interface-meta">
            <SpecBadge spec={card.spec} />
            <small className="muted">{column}</small>
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Every interface on the board, by the person building it, with a form to add more. */
export function InterfacesDialog({
  board,
  readOnly,
  onClose,
  onOpenCard,
}: {
  board: Board
  readOnly: boolean
  onClose: () => void
  onOpenCard: (cardId: string) => void
}) {
  const { state, dispatch } = useStore()
  const cloud = useCloud()
  const [title, setTitle] = useState('')
  const [senderAdapter, setSenderAdapter] = useState<AdapterType>('idoc')
  const [receiverAdapter, setReceiverAdapter] = useState<AdapterType>('http')
  const [memberId, setMemberId] = useState('')
  const [columnId, setColumnId] = useState(board.columnIds[0] ?? '')

  const items = board.columnIds.flatMap((id) => {
    const column = state.columns[id]
    if (!column) return []
    const done = isDoneColumn(column.title)
    return column.cardIds.flatMap((cardId) => {
      const card = state.cards[cardId]
      return card ? [{ card, column: column.title, done }] : []
    })
  })
  const list = listInterfaces(board.team, items)
  const target = state.columns[columnId] ? columnId : board.columnIds[0]

  const add = (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !target) return
    dispatch({
      type: 'card/addInterface',
      columnId: target,
      id: createId(),
      title,
      senderAdapter,
      receiverAdapter,
      memberId: memberId || null,
      now: Date.now(),
    })
    setTitle('')
  }

  return (
    <Modal title="Interfaces" onClose={onClose} wide>
      <h2>Interfaces</h2>
      <p className="muted small">
        The SAP CPI integrations each person builds, with their specs. Open one to write or change its spec.
      </p>

      {!readOnly && (
        <form className="interface-add" onSubmit={add} aria-label="Add an interface">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Interface name, e.g. Sales order to Salesforce"
            aria-label="Interface name"
          />
          <AdapterSelect label="Sender adapter" value={senderAdapter} onChange={setSenderAdapter} />
          <span className="spec-route-arrow" aria-hidden>
            →
          </span>
          <AdapterSelect label="Receiver adapter" value={receiverAdapter} onChange={setReceiverAdapter} />
          <select value={memberId} onChange={(e) => setMemberId(e.target.value)} aria-label="Built by">
            <option value="">Nobody yet</option>
            {board.team.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <select value={target} onChange={(e) => setColumnId(e.target.value)} aria-label="Column">
            {board.columnIds.map((id) => (
              <option key={id} value={id}>
                {state.columns[id]?.title}
              </option>
            ))}
          </select>
          <button className="button primary" type="submit" disabled={!title.trim() || !target}>
            Add interface
          </button>
        </form>
      )}
      {!readOnly && board.team.length === 0 && (
        <p className="muted small">Add people under Team to give each interface someone who builds it.</p>
      )}

      {list.total === 0 ? (
        <p className="muted">
          No interfaces yet. Add one above, or open any card and choose “Add interface spec”.
        </p>
      ) : (
        <>
          <div className="interface-groups">
            {list.members.map(({ member, items: mine, agreed, done }) => (
              <section key={member.id} className="interface-group" aria-label={`Interfaces: ${member.name}`}>
                <header className="workload-head">
                  <Avatar person={member} />
                  <div className="workload-name">
                    <strong>{member.name}</strong>
                    <small className="muted">
                      {mine.length} interface{mine.length === 1 ? '' : 's'} · {agreed} spec{agreed === 1 ? '' : 's'}{' '}
                      agreed · {done} done
                    </small>
                  </div>
                </header>
                {mine.length > 0 ? (
                  <InterfaceRows items={mine} onOpenCard={onOpenCard} />
                ) : (
                  <p className="muted small">Nothing to build yet.</p>
                )}
              </section>
            ))}
            {list.unassigned.length > 0 && (
              <section className="interface-group" aria-label="Interfaces: Nobody yet">
                <header className="workload-head">
                  <span className="avatar avatar-empty" aria-hidden>
                    ?
                  </span>
                  <div className="workload-name">
                    <strong>Nobody yet</strong>
                    <small className="muted">
                      {list.unassigned.length} interface{list.unassigned.length === 1 ? '' : 's'} without a builder
                    </small>
                  </div>
                </header>
                <InterfaceRows items={list.unassigned} onOpenCard={onOpenCard} />
              </section>
            )}
          </div>
          <div className="composer-actions">
            <button
              type="button"
              className="button"
              onClick={() => {
                const files: Record<string, string[]> = {}
                for (const a of sortedFiles(cloud?.attachments ?? []))
                  (files[a.cardId] ??= []).push(a.category === 'other' ? a.name : `${a.name} (${categoryName[a.category]})`)
                downloadMarkdown(board.title, specsMarkdown(board.title, list, files))
              }}
            >
              Download specs (.md)
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
