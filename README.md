# TodoList Kanban

A kanban board for work and daily life. It works in the browser with no account, saving boards to `localStorage`. Point it at a Postgres database to add accounts, so people can keep boards in their account and share them with each other.

## Features

- **Boards**: as many as you like, created from a Work, Daily life or Blank template; rename, delete and switch between them.
- **Columns**: add, rename (double-click the title), reorder by dragging, delete, clear, and an optional work-in-progress limit that turns the count red when exceeded.
- **Cards**: quick add, drag within and across columns (mouse, touch press-and-hold, or keyboard), and a detail dialog for title, notes, labels, priority, due date, checklist, duplicate and delete.
- **Labels**: per-board, with colors; manage them from the board menu or create them right in a card.
- **Due dates**: cards show Overdue, Today and Soon at a glance.
- **Search and filter**: full-text search over titles, notes and checklists, plus filters by label, priority and due date.
- **Backup**: export all boards to JSON and import them again.
- **Light and dark themes**, following the system by default.
- **Accounts and sharing** (optional, with your own Postgres): sign in with an email and password, keep boards in your account on every device, invite people by email or with a link as editors or viewers, accept or decline invitations, change roles, remove people or leave a board. Shared boards update live.
- **Automation** (with accounts): API keys, a REST API and an MCP server, so n8n, scripts and AI agents can manage boards. Claude connects with a sign-in, no key needed.
- **Keyboard shortcuts**: `/` search, `N` new card, `F` filters, `Enter` open card, `Space` pick up and drop, `?` list them all.

## Getting started

Requires Node 22 or newer.

```bash
npm install
npm run dev        # http://localhost:5173
```

## Accounts and sharing

Without a database the app runs on this device only. To turn on accounts and shared boards, point it at any Postgres database (version 14 or newer). The app's own small server (`server/`) sits between the browser and Postgres: a browser can't hold database credentials safely, and the server is what checks who may see or change each board.

1. Copy `.env.example` to `.env.local` (or `.env`) and set `DATABASE_URL` to your Postgres connection string.
2. Run `npm run dev` and open http://localhost:5173. It starts the app and its server together; on the first run the server creates its tables in a **`kanban` schema**, so it can share a database with other applications and leaves their tables alone.
3. The app opens on a **Sign in** page; nobody can use it without an account while accounts are on. If you see the board instead, check the terminal: without `DATABASE_URL` it says accounts are off, and a database error stops the server with the reason.

To run it as one thing, `npm run build` then `npm run server`: the server also serves the built app, by default on http://localhost:8787.

### Deploying

Accounts need the server running where you host the app; a static site host serves only the page, so the app stays on each device with no sign-in. The `Dockerfile` builds the app and runs the server, which serves both on port 8787. On Coolify:

1. Set the build pack to **Dockerfile** (not Nixpacks static, and not "Is it a static site?").
2. Set **Ports Exposes** to `8787`.
3. Add the environment variables `DATABASE_URL` (a Postgres the Coolify server can reach) and `COOKIE_SECURE=true`.
4. Deploy. Opening `https://your-domain/api/auth/me` should show `{"user":null}`; if it shows the app's page, the server isn't running.

How it works:

- **Accounts**: people sign up with an email and a password (at least 8 characters). Passwords are stored as scrypt hashes, and sessions as hashes of a random token in an `HttpOnly` cookie. To reset a forgotten password, run `npm run server:set-password -- someone@example.com 'their new password'`; that also signs them out everywhere.
- **Roles**: each shared board has one **owner** (invites people, changes roles, removes people, deletes the board), **editors** (change everything on the board) and **viewers** (read only). The server checks every request against these roles.
- **Invites by email**: the person sees the invitation once they sign in with that address, and can accept or decline. The app does not send an email for it, so let them know.
- **Invite links**: anyone with the link can join with the link's role after signing in, until the owner turns the link off.
- **Device boards**: boards made before accounts were turned on stay on the device and show up after signing in, under "On this device". Use **Share board…** and **Move to my account** to upload one. Signing out returns to the sign-in page and removes account boards from the device; they come back on sign-in.
- **Live updates**: Postgres `LISTEN`/`NOTIFY` feeds a stream of events to each browser, so changes appear for other members within a moment. Edits to different cards merge; if two people change the same card at once, the last save wins.

### Settings

| Variable | What it does |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. Required by the server. |
| `PORT` | Port for the server (default 8787). |
| `COOKIE_SECURE` | Set to `true` when serving over https, so the session cookie is https-only. |
| `PUBLIC_URL` | The site's public address, e.g. `https://workstream.teddybiere.info`, used in OAuth discovery for Claude. Optional: by default it comes from the request and proxy headers. |
| `VITE_API_URL` | Where the app looks for the API (default `/api`). Set it only when the server runs on another address; `off` turns accounts off. |

Behind a reverse proxy, forward `/api` to the server and keep the app on the same origin, so the session cookie is sent.

## Automation: REST API, MCP and n8n

With accounts on, other tools can manage boards for you. Each person creates their own **API keys** in the app (account menu → **API keys…**). A key acts as that person, with their role on each board: viewers can only read, editors and owners can change, and only owners can delete a board. The key is shown once; the server keeps only a hash of it. Revoke it from the same dialog. Resetting someone's password with `server:set-password` also revokes their API keys.

Send the key in an `X-API-Key: kbn_...` header (`Authorization: Bearer kbn_...` works too) to either of these:

- **REST API** at `/api/v1`, described by `/api/v1/openapi.json` (OpenAPI 3).
- **MCP server** at `/api/mcp` (Streamable HTTP), for AI agents. Tools: `list_boards`, `get_board`, `create_board`, `rename_board`, `add_column`, `update_column`, `delete_column`, `find_cards`, `get_card`, `create_card`, `update_card`, `move_card`, `delete_card`. Deleting a whole board is left to the REST API and the app.

| Request | What it does |
| --- | --- |
| `GET /api/v1/boards` | Your boards, with your role and card count |
| `POST /api/v1/boards` | Create a board: `{"title": "Inbox", "columns": ["To do", "Done"]}` |
| `GET /api/v1/boards/{boardId}` | A board with its labels, columns and cards |
| `PATCH` / `DELETE /api/v1/boards/{boardId}` | Rename it, or delete it (owner only) |
| `POST /api/v1/boards/{boardId}/columns` | Add a column: `{"title": "Waiting", "position": 1}` |
| `PATCH` / `DELETE /api/v1/boards/{boardId}/columns/{column}` | Rename, set the WIP limit or move a column; delete it with its cards. `{column}` is an id or a title |
| `POST /api/v1/boards/{boardId}/cards` | Add a card: `{"column": "To do", "title": "Call the bank", "priority": "high", "dueDate": "2026-12-01", "labels": ["Finance"], "checklist": ["Find the papers"]}` |
| `GET /api/v1/cards?search=&label=&priority=&column=&dueFrom=&dueTo=&boardId=&limit=` | Find cards on all your boards |
| `GET` / `PATCH` / `DELETE /api/v1/cards/{cardId}` | Read, change or delete a card. `PATCH {"column": "Done"}` moves it; fields you leave out stay as they are |

Columns can be named by title (any case), labels by name; a label name the board doesn't have yet becomes a new label. Positions start at 0 (top or left); leaving `position` out puts the item at the end. Changes appear live in the app for everyone on the board.

### Claude (custom connector)

Claude connects to the MCP server with OAuth, so there is no key to paste: you sign in with your app account and allow it.

1. In Claude, open **Settings → Connectors → Add custom connector**.
2. Enter a name and the URL `https://your-domain/api/mcp`. Leave the OAuth Client ID and secret empty. The site address on its own (`https://your-domain`) and `/api/mcp/` with a trailing slash work too.
3. Click **Connect**. A TodoList Kanban page opens: sign in (if you aren't already) and click **Allow**.

Claude then acts as you, with your role on each board. The app lists it under **Connected apps** in the **API keys…** dialog, where **Disconnect** stops its access at once. Resetting someone's password also disconnects their apps.

How it works: `/api/mcp` answers unauthenticated requests with `401` and a `WWW-Authenticate` header pointing at `/.well-known/oauth-protected-resource/api/mcp`. The server is its own OAuth 2.1 authorization server (`/.well-known/oauth-authorization-server`) with dynamic client registration, the authorization code flow with PKCE (S256), one-hour access tokens and rotating refresh tokens. Only hashes of codes, tokens and client secrets are stored. The server works out its public address from the proxy's `X-Forwarded-Proto` and `X-Forwarded-Host` headers; set `PUBLIC_URL` if that comes out wrong.

### n8n setup

1. In the app, open the account menu → **API keys…**, create a key named `n8n` and copy it.
2. In n8n, create a **Header Auth** credential with Name `X-API-Key` and Value set to the key.
3. **Workflows (HTTP Request node)**: set Authentication to *Generic Credential Type* → *Header Auth* and pick the credential. For example, to add a card for each new email: Method `POST`, URL `https://your-domain/api/v1/boards/<boardId>/cards`, Send Body → JSON `{"column": "To do", "title": "{{ $json.subject }}"}`. Get board ids from `GET https://your-domain/api/v1/boards`.
4. **AI agents (MCP Client Tool)**: add an *AI Agent* node and attach an *MCP Client Tool* with Endpoint `https://your-domain/api/mcp`, Server Transport *HTTP Streamable*, Authentication *Header Auth* with the same credential, and Tools to Include *All*. The agent can then list boards, add, update, move and find cards.

For the deployed app, `your-domain` is `workstream.teddybiere.info`.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the app on port 5173, plus the API server when `DATABASE_URL` is set |
| `npm run dev:app` | Start only the Vite dev server |
| `npm run build` | Typecheck and build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm test` | Run the app, server and database tests once (Vitest, Testing Library, PGlite) |
| `npm run server` | Start the API server (and serve `dist/` if it was built) |
| `npm run dev:server` | Start the API server and restart it on changes |
| `npm run server:set-password` | Set someone's password: `-- them@example.com 'new password'` |
| `npm run lint` | Lint with oxlint |
| `npm run typecheck` | Run `tsc -b` |

## Project layout

```
src/
  types.ts            Data model: boards, columns, cards, labels, filters
  state/reducer.ts    All state changes, as a pure reducer
  state/storage.ts    localStorage load/save, sample data
  state/store.tsx     React provider; saves state after changes
  cloud/              Accounts and sharing: backend API (the server, in-memory for tests), sync engine
  lib/                Dates, filtering, theme, backup helpers
  components/         Board, Column, CardItem, CardModal, FilterBar, Sharing, ...
server/
  src/                API server: accounts, boards, members, invites, live updates,
                      API keys, REST API (rest.ts, openapi.ts), MCP server (mcp.ts)
                      and OAuth for MCP clients such as Claude (oauth.ts)
  migrations/         Database schema, applied on start
  tests/              API tests, run against a real Postgres engine (PGlite)
```

Drag and drop uses [dnd-kit](https://dndkit.com/).
