# TodoList Kanban

A kanban board for work and daily life. Everything runs in the browser and is saved to `localStorage`; there is no server or account.

## Features

- **Boards**: as many as you like, created from a Work, Daily life or Blank template; rename, delete and switch between them.
- **Columns**: add, rename (double-click the title), reorder by dragging, delete, clear, and an optional work-in-progress limit that turns the count red when exceeded.
- **Cards**: quick add, drag within and across columns (mouse, touch press-and-hold, or keyboard), and a detail dialog for title, notes, labels, priority, due date, checklist, duplicate and delete.
- **Labels**: per-board, with colors; manage them from the board menu or create them right in a card.
- **Due dates**: cards show Overdue, Today and Soon at a glance.
- **Search and filter**: full-text search over titles, notes and checklists, plus filters by label, priority and due date.
- **Backup**: export all boards to JSON and import them again.
- **Light and dark themes**, following the system by default.
- **Keyboard shortcuts**: `/` search, `N` new card, `F` filters, `Enter` open card, `Space` pick up and drop, `?` list them all.

## Getting started

Requires Node 20 or newer.

```bash
npm install
npm run dev        # http://localhost:5173
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Typecheck and build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm test` | Run the unit and component tests once (Vitest + Testing Library) |
| `npm run lint` | Lint with oxlint |
| `npm run typecheck` | Run `tsc -b` |

## Project layout

```
src/
  types.ts            Data model: boards, columns, cards, labels, filters
  state/reducer.ts    All state changes, as a pure reducer
  state/storage.ts    localStorage load/save, sample data
  state/store.tsx     React provider; saves state after changes
  lib/                Dates, filtering, theme, backup helpers
  components/         Board, Column, CardItem, CardModal, FilterBar, ...
```

Drag and drop uses [dnd-kit](https://dndkit.com/).
