# TodoList Kanban

A kanban board for work and daily life. It works in the browser with no account, saving boards to `localStorage`. Connect a free [Supabase](https://supabase.com) project to add accounts, so people can keep boards in their account and share them.

## Features

- **Boards**: as many as you like, created from a Work, Daily life or Blank template; rename, delete and switch between them.
- **Columns**: add, rename (double-click the title), reorder by dragging, delete, clear, and an optional work-in-progress limit that turns the count red when exceeded.
- **Cards**: quick add, drag within and across columns (mouse, touch press-and-hold, or keyboard), and a detail dialog for title, notes, labels, priority, due date, checklist, duplicate and delete.
- **Labels**: per-board, with colors; manage them from the board menu or create them right in a card.
- **Due dates**: cards show Overdue, Today and Soon at a glance.
- **Search and filter**: full-text search over titles, notes and checklists, plus filters by label, priority and due date.
- **Backup**: export all boards to JSON and import them again.
- **Light and dark themes**, following the system by default.
- **Accounts and sharing** (optional, with Supabase): sign in with an emailed link, keep boards in your account on every device, invite people by email or with a link as editors or viewers, accept or decline invitations, change roles, remove people or leave a board. Shared boards update live.
- **Keyboard shortcuts**: `/` search, `N` new card, `F` filters, `Enter` open card, `Space` pick up and drop, `?` list them all.

## Getting started

Requires Node 20 or newer.

```bash
npm install
npm run dev        # http://localhost:5173
```

## Accounts and sharing

Without configuration the app runs on this device only. To turn on accounts and shared boards:

1. Create a project at [supabase.com](https://supabase.com) (the free plan is enough).
2. In the project's **SQL Editor**, run [`supabase/migrations/20261006000000_members_and_sharing.sql`](supabase/migrations/20261006000000_members_and_sharing.sql). It creates the tables, the access rules and the invite functions. (With the Supabase CLI: `supabase link` then `supabase db push`.)
3. In **Authentication > URL Configuration**, set the **Site URL** to where the app runs (for example `http://localhost:5173`) and add any other addresses you use, such as your deployed site, to **Redirect URLs**. Sign-in links go back to these.
4. Copy `.env.example` to `.env.local` and fill in the **Project URL** and **anon public** key from **Settings > API**. The anon key is safe in the browser; the access rules protect the data.
5. Restart `npm run dev`. A **Sign in** button appears in the top bar.

How it works:

- **Roles**: each shared board has one **owner** (invites people, changes roles, removes people, deletes the board), **editors** (change everything on the board) and **viewers** (read only). The database enforces this with row-level security, not just the app.
- **Invites by email**: the person sees the invitation after signing in with that address and can accept or decline. The app does not send an email for it, so let them know.
- **Invite links**: anyone with the link can join with the link's role after signing in, until the owner turns the link off.
- **Device boards**: boards made while signed out stay on the device. Use **Share board…** and **Move to my account** to upload one. Signing out removes account boards from the device; they come back on sign-in.
- **Live updates**: changes appear for other members within a moment. Edits to different cards merge; if two people change the same card at once, the last save wins.

Supabase's built-in email service is rate limited and meant for testing. For real use, set up your own SMTP server under **Authentication > Emails**.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Typecheck and build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm test` | Run the unit, component and database access-rule tests once (Vitest, Testing Library, PGlite) |
| `npm run lint` | Lint with oxlint |
| `npm run typecheck` | Run `tsc -b` |

## Project layout

```
src/
  types.ts            Data model: boards, columns, cards, labels, filters
  state/reducer.ts    All state changes, as a pure reducer
  state/storage.ts    localStorage load/save, sample data
  state/store.tsx     React provider; saves state after changes
  cloud/              Accounts and sharing: backend API (Supabase, in-memory for tests), sync engine
  lib/                Dates, filtering, theme, backup helpers
  components/         Board, Column, CardItem, CardModal, FilterBar, Sharing, ...
supabase/
  migrations/         Database schema, access rules and invite functions
  tests/              Access-rule tests, run against the migration in PGlite
```

Drag and drop uses [dnd-kit](https://dndkit.com/).
