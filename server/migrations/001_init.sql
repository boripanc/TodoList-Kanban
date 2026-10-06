-- TodoList Kanban server schema. Everything lives in the "kanban" schema so it
-- can share a database with other applications without touching their tables.
-- Access rules (who may read or change what) are enforced by the server.

create table kanban.users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);
create unique index users_email_idx on kanban.users (lower(email));

create table kanban.sessions (
  token_hash text primary key,
  user_id uuid not null references kanban.users (id) on delete cascade,
  expires_at timestamptz not null
);
create index sessions_user_id_idx on kanban.sessions (user_id);

create table kanban.boards (
  id text primary key,
  owner_id uuid not null references kanban.users (id) on delete cascade,
  title text not null,
  labels jsonb not null default '[]'::jsonb,
  created_at bigint not null,
  updated_at timestamptz not null default clock_timestamp()
);

create table kanban.board_members (
  board_id text not null references kanban.boards (id) on delete cascade,
  user_id uuid not null references kanban.users (id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (board_id, user_id)
);
create index board_members_user_id_idx on kanban.board_members (user_id);
create unique index board_members_one_owner_idx on kanban.board_members (board_id) where role = 'owner';

create table kanban.columns (
  id text primary key,
  board_id text not null references kanban.boards (id) on delete cascade,
  position integer not null,
  title text not null,
  wip_limit integer not null default 0,
  unique (id, board_id)
);
create index columns_board_id_idx on kanban.columns (board_id);

create table kanban.cards (
  id text primary key,
  board_id text not null references kanban.boards (id) on delete cascade,
  column_id text not null,
  position integer not null,
  title text not null,
  description text not null default '',
  label_ids jsonb not null default '[]'::jsonb,
  priority text not null default 'none' check (priority in ('none', 'low', 'medium', 'high', 'urgent')),
  due_date text,
  checklist jsonb not null default '[]'::jsonb,
  created_at bigint not null,
  updated_at bigint not null,
  -- A card's column must belong to the same board.
  foreign key (column_id, board_id) references kanban.columns (id, board_id) on delete cascade
);
create index cards_board_id_idx on kanban.cards (board_id);

create table kanban.board_invites (
  id uuid primary key default gen_random_uuid(),
  board_id text not null references kanban.boards (id) on delete cascade,
  email text,
  token text unique,
  role text not null check (role in ('editor', 'viewer')),
  invited_by uuid not null references kanban.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  check ((email is null) <> (token is null))
);
create unique index board_invites_email_idx on kanban.board_invites (board_id, lower(email)) where email is not null;

-- Any change to a board's columns or cards bumps boards.updated_at. Clients
-- compare it to fetch only boards that changed.
create function kanban.touch_boards() returns trigger language plpgsql as $$
begin
  update kanban.boards set updated_at = clock_timestamp()
  where id in (select distinct board_id from changed);
  return null;
end;
$$;

create trigger columns_touch_insert after insert on kanban.columns
  referencing new table as changed for each statement execute function kanban.touch_boards();
create trigger columns_touch_update after update on kanban.columns
  referencing new table as changed for each statement execute function kanban.touch_boards();
create trigger columns_touch_delete after delete on kanban.columns
  referencing old table as changed for each statement execute function kanban.touch_boards();
create trigger cards_touch_insert after insert on kanban.cards
  referencing new table as changed for each statement execute function kanban.touch_boards();
create trigger cards_touch_update after update on kanban.cards
  referencing new table as changed for each statement execute function kanban.touch_boards();
create trigger cards_touch_delete after delete on kanban.cards
  referencing old table as changed for each statement execute function kanban.touch_boards();

create function kanban.touch_board_row() returns trigger language plpgsql as $$
begin
  new.updated_at = clock_timestamp();
  return new;
end;
$$;

create trigger boards_touch_row before update on kanban.boards
  for each row execute function kanban.touch_board_row();

-- Live updates: the server LISTENs on "kanban_events" and forwards these to
-- the people concerned.
create function kanban.notify_board() returns trigger language plpgsql as $$
begin
  perform pg_notify('kanban_events', json_build_object('type', 'board', 'boardId', new.id)::text);
  return null;
end;
$$;

create trigger boards_notify after update on kanban.boards
  for each row execute function kanban.notify_board();

create function kanban.notify_member() returns trigger language plpgsql as $$
declare
  r record;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  perform pg_notify(
    'kanban_events',
    json_build_object('type', 'member', 'boardId', r.board_id, 'userId', r.user_id)::text
  );
  return null;
end;
$$;

create trigger board_members_notify after insert or update or delete on kanban.board_members
  for each row execute function kanban.notify_member();
