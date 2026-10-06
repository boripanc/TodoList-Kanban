import type { Board, CardFilter, DueFilter, Priority } from '../types'
import { emptyFilter, isFilterActive } from '../lib/filter'
import { priorityLabel } from '../lib/priority'

const dueOptions: { value: DueFilter; label: string }[] = [
  { value: 'any', label: 'Any due date' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Due today' },
  { value: 'week', label: 'Due in 7 days' },
  { value: 'none', label: 'No due date' },
]

const priorities: Priority[] = ['urgent', 'high', 'medium', 'low', 'none']

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

export function FilterBar({
  board,
  filter,
  onChange,
}: {
  board: Board
  filter: CardFilter
  onChange: (filter: CardFilter) => void
}) {
  return (
    <div className="filter-bar" role="group" aria-label="Filters">
      <div className="filter-group">
        <span className="filter-heading">Labels</span>
        {board.labels.length === 0 && <span className="muted small">None</span>}
        {board.labels.map((label) => (
          <button
            key={label.id}
            className={`label-chip toggle ${filter.labelIds.includes(label.id) ? 'on' : ''}`}
            style={{ '--label': label.color } as React.CSSProperties}
            aria-pressed={filter.labelIds.includes(label.id)}
            onClick={() => onChange({ ...filter, labelIds: toggle(filter.labelIds, label.id) })}
          >
            {label.name}
          </button>
        ))}
      </div>
      <div className="filter-group">
        <span className="filter-heading">Priority</span>
        {priorities.map((p) => (
          <button
            key={p}
            className={`chip ${filter.priorities.includes(p) ? 'on' : ''}`}
            aria-pressed={filter.priorities.includes(p)}
            onClick={() => onChange({ ...filter, priorities: toggle(filter.priorities, p) })}
          >
            {priorityLabel[p]}
          </button>
        ))}
      </div>
      <div className="filter-group">
        <label className="filter-heading" htmlFor="due-filter">
          Due
        </label>
        <select
          id="due-filter"
          value={filter.due}
          onChange={(e) => onChange({ ...filter, due: e.target.value as DueFilter })}
        >
          {dueOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {isFilterActive(filter) && (
        <button className="button ghost" onClick={() => onChange(emptyFilter)}>
          Clear filters
        </button>
      )}
    </div>
  )
}
