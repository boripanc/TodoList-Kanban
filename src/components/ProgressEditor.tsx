import { useState } from 'react'
import type { Card } from '../types'
import { useStore } from '../state/context'
import { createId } from '../lib/id'

const formatWhen = (at: number) =>
  new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** The card's progress percentage and its log of progress updates. */
export function ProgressEditor({ card }: { card: Card }) {
  const { dispatch } = useStore()
  const [note, setNote] = useState('')

  const setProgress = (progress: number | null) =>
    dispatch({ type: 'card/update', cardId: card.id, patch: { progress }, now: Date.now() })

  const addNote = () => {
    const text = note.trim()
    if (!text) return
    dispatch({ type: 'card/logProgress', cardId: card.id, id: createId(), text, progress: card.progress, now: Date.now() })
    setNote('')
  }

  return (
    <div className="field progress-field">
      <span>Progress{card.progress !== null && ` (${card.progress}%)`}</span>
      {card.progress === null ? (
        <div>
          <button className="button" onClick={() => setProgress(0)}>
            Track progress
          </button>
        </div>
      ) : (
        <div className="progress-row">
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={card.progress}
            aria-label="Progress percent"
            aria-valuetext={`${card.progress}%`}
            onChange={(e) => setProgress(Number(e.target.value))}
          />
          <input
            type="number"
            min={0}
            max={100}
            className="progress-number"
            value={card.progress}
            aria-label="Progress percent (number)"
            onChange={(e) => e.target.value !== '' && setProgress(Number(e.target.value))}
          />
          <button className="icon-button" aria-label="Stop tracking progress" onClick={() => setProgress(null)}>
            ✕
          </button>
        </div>
      )}

      <div className="checklist-add">
        <input
          value={note}
          placeholder="Add a progress update"
          aria-label="Progress update"
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addNote()}
        />
        <button className="button" onClick={addNote} disabled={!note.trim()}>
          Add
        </button>
      </div>
      {card.progressLog.length > 0 && (
        <ul className="progress-log" aria-label="Progress updates">
          {[...card.progressLog].reverse().map((entry) => (
            <li key={entry.id}>
              <div>
                <small className="muted">
                  {formatWhen(entry.at)}
                  {entry.progress !== null && ` · ${entry.progress}%`}
                </small>
                {entry.text && <div className="progress-log-text">{entry.text}</div>}
              </div>
              <button
                className="icon-button"
                aria-label={`Remove update "${entry.text || `${entry.progress}%`}"`}
                onClick={() =>
                  dispatch({ type: 'card/deleteProgress', cardId: card.id, entryId: entry.id, now: Date.now() })
                }
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
