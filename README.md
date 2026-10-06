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
- **Keyboard shortcuts**: `/` search, `N` new card, `F` filters, `Enter` open card, `Space` pick up and drop, `?` list them all.

## Getting started

Requires Node 22 or newer.

```bash
npm install
npm run dev        # http://localhost:5173
```

## Accounts and sharing

Without a database the app runs on this device only. To turn on accounts and shared boards, point it at any Postgres database (version 14 or newer). The app's own small server (`server/`) sits between the browser and Postgres: a browser can't hold database credentials safely, and the server is what checks who may see or change each board.

1. Copy `.env.example` to `.env.local` and set `DATABASE_URL` to your Postgres connection string.
2. Run `npm run dev` and open http://localhost:5173. It starts the app and its server together; on the first run the server creates its tables in a **`kanban` schema**, so it can share a database with other applications and leaves their tables alone.
3. A **Sign in** button appears in the top bar. If it doesn't, check the terminal: without `DATABASE_URL` it says accounts are off, and a database error stops the server with the reason.

To run it as one thing, `npm run build` then `npm run server`: the server also serves the built app, by default on http://localhost:8787.

How it works:

- **Accounts**: people sign up with an email and a password (at least 8 characters). Passwords are stored as scrypt hashes, and sessions as hashes of a random token in an `HttpOnly` cookie. To reset a forgotten password, run `npm run server:set-password -- someone@example.com 'their new password'`; that also signs them out everywhere.
- **Roles**: each shared board has one **owner** (invites people, changes roles, removes people, deletes the board), **editors** (change everything on the board) and **viewers** (read only). The server checks every request against these roles.
- **Invites by email**: the person sees the invitation once they sign in with that address, and can accept or decline. The app does not send an email for it, so let them know.
- **Invite links**: anyone with the link can join with the link's role after signing in, until the owner turns the link off.
- **Device boards**: boards made while signed out stay on the device. Use **Share board…** and **Move to my account** to upload one. Signing out removes account boards from the device; they come back on sign-in.
- **Live updates**: Postgres `LISTEN`/`NOTIFY` feeds a stream of events to each browser, so changes appear for other members within a moment. Edits to different cards merge; if two people change the same card at once, the last save wins.

### Settings

| Variable | What it does |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. Required by the server. |
| `PORT` | Port for the server (default 8787). |
| `COOKIE_SECURE` | Set to `true` when serving over https, so the session cookie is https-only. |
| `VITE_API_URL` | Where the app looks for the API (default `/api`). Set it only when the server runs on another address; `off` turns accounts off. |

Behind a reverse proxy, forward `/api` to the server and keep the app on the same origin, so the session cookie is sent.

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
  src/                API server: accounts, boards, members, invites, live updates
  migrations/         Database schema, applied on start
  tests/              API tests, run against a real Postgres engine (PGlite)
```

Drag and drop uses [dnd-kit](https://dndkit.com/).
