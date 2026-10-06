# TodoList Kanban

Kanban board web app for work and daily life. Client-only: React 19 + TypeScript + Vite, state in `localStorage`, no backend.

## Run and check

- `npm install`, then `npm run dev` (port 5173).
- Before pushing, run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`; CI runs the same.

## Conventions

- All state changes go through the pure reducer in `src/state/reducer.ts`. Components dispatch actions; they never mutate state. Ids and timestamps are created by the caller and passed in the action, so the reducer stays deterministic and testable.
- Data shape lives in `src/types.ts`. If you change it in a way that breaks saved data, bump `version` in `AppState` and migrate in `loadState` rather than dropping users' boards.
- Drag and drop uses dnd-kit (`src/components/Board.tsx`). Cards and columns carry `data.type` (`'card'` or `'column'`).
- Styling is plain CSS in `src/index.css` with color tokens on `:root` and a dark theme; reuse tokens instead of hard-coding colors.
- Every new reducer action gets a test in `src/state/reducer.test.ts`; user-visible flows get a Testing Library test in `src/App.test.tsx`.
- Keep the app usable by keyboard and on phone-width screens.
