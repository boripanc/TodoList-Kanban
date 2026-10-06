# TodoList Kanban

Kanban board web app for work and daily life. React 19 + TypeScript + Vite, state in `localStorage`. Optional accounts and shared boards use Supabase (`src/cloud/`, `supabase/`); without `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` the app runs on the device only.

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
- Cloud boards are ordinary boards with `board.cloud = { role }`. Components keep dispatching normal actions; `CloudSync` (`src/cloud/sync.ts`) diffs each cloud board against the server's last version and writes only changed rows. Server deletes happen only through explicit calls (`deleteBoard`), never because a board vanished locally. The reducer refuses edits to boards where the role is `viewer`.
- Database changes go in a new file under `supabase/migrations/`; access rules get a test in `supabase/tests/policies.test.ts`. Keep `src/cloud/memoryApi.ts` behaving like the database rules, since the app tests use it.
