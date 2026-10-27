import { useEffect, useRef, useState } from 'react'
import type { Board, Card, InterfaceKind, InterfaceSpec } from '../types'
import { useStore } from '../state/context'
import { createId } from '../lib/id'
import { isDoneColumn } from '../lib/done'
import {
  interfaceKinds,
  kindName,
  kindShort,
  listInterfaces,
  missingSpecFields,
  specFields,
  specsMarkdown,
  specStatuses,
  statusName,
  type InterfaceItem,
} from '../lib/interfaces'
import { Avatar } from './Team'
import { Modal } from './Modal'

type TextKey = (typeof specFields)[number]['key']
type Drafts = Record<TextKey, string>

const draftsOf = (spec: InterfaceSpec): Drafts => ({
  endpoint: spec.endpoint,
  input: spec.input,
  output: spec.output,
  notes: spec.notes,
})

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
        <small className="muted">For an interface someone has to build: endpoint, input, output and notes.</small>
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
  return (
    <section className="spec-editor" aria-label="Interface spec">
      <div className="spec-editor-head">
        <h3>Interface spec</h3>
        <label className="spec-select">
          <span className="sr-only">Interface kind</span>
          <select value={spec.kind} onChange={(e) => update({ kind: e.target.value as InterfaceKind })}>
            {interfaceKinds.map((k) => (
              <option key={k} value={k}>
                {kindName[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="spec-select">
          <span className="sr-only">Spec status</span>
          <select
            className={`spec-status-select spec-${spec.status}`}
            value={spec.status}
            onChange={(e) => update({ status: e.target.value as InterfaceSpec['status'] })}
          >
            {specStatuses.map((s) => (
              <option key={s} value={s}>
                {statusName[s]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {specFields.map((f) => (
        <label key={f.key} className="field">
          <span>{f.name}</span>
          {f.key === 'endpoint' ? (
            <input
              className="mono"
              value={drafts.endpoint}
              placeholder={f.hint}
              onChange={(e) => setDrafts({ ...drafts, endpoint: e.target.value })}
              onBlur={commit}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
          ) : (
            <textarea
              className="mono"
              rows={f.key === 'notes' ? 3 : 4}
              value={drafts[f.key]}
              placeholder={f.hint}
              onChange={(e) => setDrafts({ ...drafts, [f.key]: e.target.value })}
              onBlur={commit}
            />
          )}
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
      title={`${kindName[spec.kind]} interface, spec ${statusName[spec.status].toLowerCase()}`}
    >
      ⇄ {kindShort[spec.kind]} · {statusName[spec.status]}
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
  return (
    <ul className="interface-list">
      {items.map(({ card, column, done }) => (
        <li key={card.id} className={done ? 'is-done' : undefined}>
          <div className="interface-main">
            <button type="button" className="link interface-title" onClick={() => onOpenCard(card.id)}>
              {card.title}
            </button>
            {card.spec.endpoint.trim() && <code className="interface-endpoint">{card.spec.endpoint.trim()}</code>}
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
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<InterfaceKind>('api')
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
      kind,
      memberId: memberId || null,
      now: Date.now(),
    })
    setTitle('')
  }

  return (
    <Modal title="Interfaces" onClose={onClose} wide>
      <h2>Interfaces</h2>
      <p className="muted small">
        What each person has to build, with its technical spec. Open an interface to write or change its spec.
      </p>

      {!readOnly && (
        <form className="interface-add" onSubmit={add} aria-label="Add an interface">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Interface name, e.g. Create order"
            aria-label="Interface name"
          />
          <select value={kind} onChange={(e) => setKind(e.target.value as InterfaceKind)} aria-label="Kind">
            {interfaceKinds.map((k) => (
              <option key={k} value={k}>
                {kindName[k]}
              </option>
            ))}
          </select>
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
              onClick={() => downloadMarkdown(board.title, specsMarkdown(board.title, list))}
            >
              Download specs (.md)
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
