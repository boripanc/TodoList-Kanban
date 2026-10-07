# TodoList Kanban

Kanban board web app for work and daily life. React 19 + TypeScript + Vite, state in `localStorage`. Optional accounts and shared boards run on the project's own Node server (`server/`, Hono) backed by any Postgres; without `DATABASE_URL` (or when the server does not answer) the app runs on the device only, and `npm run dev` starts the server alongside Vite when `DATABASE_URL` is set. When the server answers, the app shows only a sign-in page until someone signs in.

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
- Database changes go in a new numbered file under `server/migrations/`, never by editing an applied one; they run on server start. Every route gets a test in `server/tests/api.test.ts`, including who is refused. Keep `src/cloud/memoryApi.ts` behaving like the server, since the app tests use it.
- The server is the only place permissions are enforced: each route checks the caller's role on that board, and request bodies go through `server/src/validate.ts` before touching the database. Treat ids in a request as the caller's claim, not a fact: the upserts refuse rows that belong to another board.
- Automation goes through API keys (`X-API-Key: kbn_...`, or the same key as `Authorization: Bearer`), which act as their owner with the same role checks. The REST API (`server/src/rest.ts`, `/api/v1`) and the MCP server (`server/src/mcp.ts`, `/api/mcp`) both call the operations in `server/src/kanban.ts`; add a feature there once and expose it in both. Keep `server/src/openapi.ts` in step with `rest.ts`. MCP clients such as Claude sign in with OAuth instead (`server/src/oauth.ts`): their access tokens (`kbo_...`) are checked in the same place as API keys and act as the person who allowed them.
