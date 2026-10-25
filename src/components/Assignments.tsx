import { useState } from 'react'
import type { AssignmentRequest } from '../cloud/api'
import type { Cloud } from '../cloud/context'
import type { Board, Card } from '../types'
import { Modal } from './Modal'

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** "Kim, Lee (new)" or "nobody", for who a request would assign. */
function requestedPeople(request: AssignmentRequest, board: Board): string {
  if (request.assignees.length === 0) return 'nobody'
  return request.assignees
    .map((p) => (p.id && board.team.some((m) => m.id === p.id) ? p.name : `${p.name} (new to the team)`))
    .join(', ')
}

function currentPeople(card: Card | undefined, board: Board): string {
  const names = (card?.assigneeIds ?? []).flatMap((id) => board.team.find((m) => m.id === id)?.name ?? [])
  return names.length ? names.join(', ') : 'nobody'
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** The bar under the top bar that says assignments are waiting on this board. */
export function AssignmentNotice({ cloud, board, onReview }: { cloud: Cloud; board: Board; onReview: () => void }) {
  const count = cloud.assignmentRequests.length
  if (count === 0) return null
  const owner = board.cloud?.role === 'owner'
  return (
    <div className="notice notice-assign" role="status">
      {owner
        ? `${count} ${plural(count, 'assignment', 'assignments')} from MCP ${plural(count, 'needs', 'need')} your approval.`
        : `${count} ${plural(count, 'assignment is', 'assignments are')} waiting for the board owner to approve.`}
      <button className="link" onClick={onReview}>
        {owner ? 'Review' : 'View'}
      </button>
    </div>
  )
}

function useAct(cloud: Cloud | null) {
  const [busy, setBusy] = useState<string | null>(null)
  const act = async (cardId: string, run: () => Promise<void>) => {
    setBusy(cardId)
    try {
      await run()
    } catch (e) {
      cloud?.reportError(e)
    } finally {
      setBusy(null)
    }
  }
  return { busy, act }
}

function Decision({ cloud, cardId, title, busy, act }: { cloud: Cloud; cardId: string; title: string } & ReturnType<typeof useAct>) {
  return (
    <>
      <button
        className="button primary"
        disabled={busy === cardId}
        aria-label={`Approve assignment for ${title}`}
        onClick={() => act(cardId, () => cloud.approveAssignment(cardId))}
      >
        Approve
      </button>
      <button
        className="button ghost"
        disabled={busy === cardId}
        aria-label={`Reject assignment for ${title}`}
        onClick={() => act(cardId, () => cloud.rejectAssignment(cardId))}
      >
        Reject
      </button>
    </>
  )
}

/** Every assignment waiting on the board, with Approve and Reject for the owner. */
export function AssignmentsDialog({
  cloud,
  board,
  cards,
  onClose,
  onOpenCard,
}: {
  cloud: Cloud
  board: Board
  cards: Record<string, Card>
  onClose: () => void
  onOpenCard: (cardId: string) => void
}) {
  const owner = board.cloud?.role === 'owner'
  const actions = useAct(cloud)
  const requests = cloud.assignmentRequests
  return (
    <Modal title="Assignments to approve" onClose={onClose}>
      <h2>Assignments to approve</h2>
      <p className="muted">
        AI agents and automations that assign cards through MCP have to wait for the board owner.
        {owner ? ' Approve to assign the card, or reject to leave it as it is.' : ''}
      </p>
      {requests.length === 0 ? (
        <p className="muted">Nothing is waiting.</p>
      ) : (
        <ul className="share-list assign-list">
          {requests.map((request) => {
            const card = cards[request.cardId]
            const title = card?.title ?? 'A card'
            return (
              <li key={request.cardId}>
                <div className="share-who">
                  {card ? (
                    <button className="link assign-card" onClick={() => onOpenCard(request.cardId)}>
                      {title}
                    </button>
                  ) : (
                    <strong>{title}</strong>
                  )}
                  <span>
                    Assign to <strong>{requestedPeople(request, board)}</strong>
                  </span>
                  <small className="muted">
                    Now: {currentPeople(card, board)} · asked {request.requestedBy ? `by ${request.requestedBy} ` : ''}
                    {when(request.requestedAt)}
                  </small>
                </div>
                {owner && <Decision cloud={cloud} cardId={request.cardId} title={title} {...actions} />}
              </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}

/** In the card dialog: the assignment waiting on this card, if any. */
export function PendingAssignment({ cloud, board, card }: { cloud: Cloud | null; board: Board; card: Card }) {
  const actions = useAct(cloud)
  const request = cloud?.assignmentRequests.find((r) => r.cardId === card.id)
  if (!cloud || !request) return null
  const owner = board.cloud?.role === 'owner'
  return (
    <div className="pending-assign" role="status">
      <span>
        Waiting for approval: assign to <strong>{requestedPeople(request, board)}</strong>
        {request.requestedBy && <small className="muted"> · asked by {request.requestedBy}</small>}
      </span>
      {owner && (
        <span className="pending-assign-actions">
          <Decision cloud={cloud} cardId={card.id} title={card.title} {...actions} />
        </span>
      )}
    </div>
  )
}
