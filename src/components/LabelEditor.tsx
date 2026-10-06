import { useState } from 'react'
import type { Board } from '../types'
import { useStore } from '../state/context'
import { labelColors } from '../state/templates'
import { createId } from '../lib/id'

/** Create a label on the board; calls onCreated with the new label's id. */
export function NewLabelForm({ board, onCreated }: { board: Board; onCreated?: (labelId: string) => void }) {
  const { dispatch } = useStore()
  const [name, setName] = useState('')
  const [color, setColor] = useState(labelColors[board.labels.length % labelColors.length])

  return (
    <form
      className="new-label"
      onSubmit={(e) => {
        e.preventDefault()
        const trimmed = name.trim()
        if (!trimmed) return
        const id = createId()
        dispatch({ type: 'label/add', boardId: board.id, label: { id, name: trimmed, color } })
        setName('')
        setColor(labelColors[(board.labels.length + 1) % labelColors.length])
        onCreated?.(id)
      }}
    >
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New label" aria-label="New label name" />
      <ColorPicker value={color} onChange={setColor} />
      <button className="button" type="submit" disabled={!name.trim()}>
        Add
      </button>
    </form>
  )
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <div className="color-picker" role="radiogroup" aria-label="Label color">
      {labelColors.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={color}
          className={`swatch ${value === color ? 'selected' : ''}`}
          style={{ background: color }}
          onClick={() => onChange(color)}
        />
      ))}
    </div>
  )
}

/** Rename, recolor and delete the labels of a board. */
export function LabelManager({ board }: { board: Board }) {
  const { dispatch } = useStore()
  return (
    <div className="label-manager">
      {board.labels.length === 0 && <p className="muted">No labels yet.</p>}
      <ul>
        {board.labels.map((label) => (
          <li key={label.id}>
            <input
              defaultValue={label.name}
              aria-label={`Label name for ${label.name}`}
              onBlur={(e) => {
                const name = e.target.value.trim()
                if (name && name !== label.name) {
                  dispatch({ type: 'label/update', boardId: board.id, labelId: label.id, patch: { name } })
                }
              }}
            />
            <ColorPicker
              value={label.color}
              onChange={(color) =>
                dispatch({ type: 'label/update', boardId: board.id, labelId: label.id, patch: { color } })
              }
            />
            <button
              className="icon-button danger"
              aria-label={`Delete label ${label.name}`}
              onClick={() => {
                if (window.confirm(`Delete label "${label.name}"? It will be removed from all cards.`)) {
                  dispatch({ type: 'label/delete', boardId: board.id, labelId: label.id })
                }
              }}
            >
              🗑
            </button>
          </li>
        ))}
      </ul>
      <NewLabelForm board={board} />
    </div>
  )
}
