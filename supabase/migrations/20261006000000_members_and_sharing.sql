-- Accounts, shared boards, roles and invites for TodoList Kanban.
--
-- Roles per board: owner (one per board, full control), editor (edit content),
-- viewer (read only). Owners invite people by email or by a shareable link.
-- Every table is protected by row-level security; clients use the anon key.

-- Profiles mirror auth.users so members can see each other's email.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null default '',
  display_name text
);

create or replace function public.handle_user_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, coalesce(new.email, ''))
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_user_change();

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function public.handle_user_change();

insert into public.profiles (id, email)
select id, coalesce(email, '') from auth.users
on conflict (id) do nothing;

-- Boards, columns and cards. Ids are created by the app, so they are text.
create table public.boards (
  id text primary key,
  owner_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title text not null,
  labels jsonb not null default '[]'::jsonb,
  created_at bigint not null,
  updated_at timestamptz not null default now()
);

create table public.board_members (
  board_id text not null references public.boards (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (board_id, user_id)
);
create index board_members_user_id_idx on public.board_members (user_id);
create unique index board_members_one_owner_idx on public.board_members (board_id) where role = 'owner';

create table public.columns (
  id text primary key,
  board_id text not null references public.boards (id) on delete cascade,
  position integer not null,
  title text not null,
  wip_limit integer not null default 0,
  unique (id, board_id)
);
create index columns_board_id_idx on public.columns (board_id);

create table public.cards (
  id text primary key,
  board_id text not null references public.boards (id) on delete cascade,
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
  foreign key (column_id, board_id) references public.columns (id, board_id) on delete cascade
);
create index cards_board_id_idx on public.cards (board_id);

-- Pending invitations: either to an email address, or a shareable link token.
create table public.board_invites (
  id uuid primary key default gen_random_uuid(),
  board_id text not null references public.boards (id) on delete cascade,
  email text,
  token text unique,
  role text not null check (role in ('editor', 'viewer')),
  invited_by uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  check ((email is null) <> (token is null))
);
create unique index board_invites_email_idx on public.board_invites (board_id, lower(email)) where email is not null;

-- Helpers. Security definer so policies can read membership without recursing.
create or replace function public.board_role(p_board text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select role from public.board_members where board_id = p_board and user_id = auth.uid();
$$;

create or replace function public.current_email()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lower(email) from auth.users where id = auth.uid();
$$;

create or replace function public.shares_board_with(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.board_members mine
    join public.board_members theirs on theirs.board_id = mine.board_id
    where mine.user_id = auth.uid() and theirs.user_id = p_user
  );
$$;

-- The creator of a board becomes its owner.
create or replace function public.add_board_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.board_members (board_id, user_id, role) values (new.id, new.owner_id, 'owner');
  return new;
end;
$$;

create trigger on_board_created
  after insert on public.boards
  for each row execute function public.add_board_owner();

-- Any change to a board's columns or cards bumps boards.updated_at, which is
-- what clients watch (live updates) and compare (refresh only what changed).
create or replace function public.touch_boards()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.boards set updated_at = clock_timestamp()
  where id in (select distinct board_id from changed);
  return null;
end;
$$;

create trigger columns_touch_insert after insert on public.columns
  referencing new table as changed for each statement execute function public.touch_boards();
create trigger columns_touch_update after update on public.columns
  referencing new table as changed for each statement execute function public.touch_boards();
create trigger columns_touch_delete after delete on public.columns
  referencing old table as changed for each statement execute function public.touch_boards();
create trigger cards_touch_insert after insert on public.cards
  referencing new table as changed for each statement execute function public.touch_boards();
create trigger cards_touch_update after update on public.cards
  referencing new table as changed for each statement execute function public.touch_boards();
create trigger cards_touch_delete after delete on public.cards
  referencing old table as changed for each statement execute function public.touch_boards();

create or replace function public.touch_board_row()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = clock_timestamp();
  return new;
end;
$$;

create trigger boards_touch_row before update on public.boards
  for each row execute function public.touch_board_row();

-- Row-level security.
alter table public.profiles enable row level security;
alter table public.boards enable row level security;
alter table public.board_members enable row level security;
alter table public.columns enable row level security;
alter table public.cards enable row level security;
alter table public.board_invites enable row level security;

create policy "see yourself and people you share a board with" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.shares_board_with(id));
create policy "edit your own profile" on public.profiles
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy "members see the board" on public.boards
  for select to authenticated using (public.board_role(id) is not null);
create policy "anyone signed in creates their own board" on public.boards
  for insert to authenticated with check (owner_id = auth.uid());
create policy "owners and editors update the board" on public.boards
  for update to authenticated
  using (public.board_role(id) in ('owner', 'editor'))
  with check (public.board_role(id) in ('owner', 'editor'));
create policy "owners delete the board" on public.boards
  for delete to authenticated using (public.board_role(id) = 'owner');

create policy "members see the member list" on public.board_members
  for select to authenticated using (public.board_role(board_id) is not null);
create policy "owners change other members' roles" on public.board_members
  for update to authenticated
  using (public.board_role(board_id) = 'owner' and role <> 'owner')
  with check (role in ('editor', 'viewer'));
create policy "owners remove members, members leave" on public.board_members
  for delete to authenticated
  using (role <> 'owner' and (user_id = auth.uid() or public.board_role(board_id) = 'owner'));

create policy "members see columns" on public.columns
  for select to authenticated using (public.board_role(board_id) is not null);
create policy "editors add columns" on public.columns
  for insert to authenticated with check (public.board_role(board_id) in ('owner', 'editor'));
create policy "editors change columns" on public.columns
  for update to authenticated
  using (public.board_role(board_id) in ('owner', 'editor'))
  with check (public.board_role(board_id) in ('owner', 'editor'));
create policy "editors delete columns" on public.columns
  for delete to authenticated using (public.board_role(board_id) in ('owner', 'editor'));

create policy "members see cards" on public.cards
  for select to authenticated using (public.board_role(board_id) is not null);
create policy "editors add cards" on public.cards
  for insert to authenticated with check (public.board_role(board_id) in ('owner', 'editor'));
create policy "editors change cards" on public.cards
  for update to authenticated
  using (public.board_role(board_id) in ('owner', 'editor'))
  with check (public.board_role(board_id) in ('owner', 'editor'));
create policy "editors delete cards" on public.cards
  for delete to authenticated using (public.board_role(board_id) in ('owner', 'editor'));

create policy "owners see invites, invitees see theirs" on public.board_invites
  for select to authenticated
  using (public.board_role(board_id) = 'owner' or (email is not null and lower(email) = public.current_email()));
create policy "owners invite" on public.board_invites
  for insert to authenticated
  with check (public.board_role(board_id) = 'owner' and invited_by = auth.uid());
create policy "owners revoke invites" on public.board_invites
  for delete to authenticated using (public.board_role(board_id) = 'owner');

-- Column-level grants: nobody can rewrite ownership or ids through an update.
revoke all on public.profiles, public.boards, public.board_members, public.columns, public.cards, public.board_invites
  from anon, authenticated;
grant select, update (display_name) on public.profiles to authenticated;
grant select, insert, delete on public.boards to authenticated;
grant update (title, labels) on public.boards to authenticated;
grant select, delete on public.board_members to authenticated;
grant update (role) on public.board_members to authenticated;
grant select, insert, update, delete on public.columns, public.cards to authenticated;
grant select, insert, delete on public.board_invites to authenticated;

-- Invitations, handled by functions so invitees never need direct write access.
create or replace function public.my_invites()
returns table (id uuid, board_id text, board_title text, role text, invited_by_email text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, i.board_id, b.title, i.role, p.email, i.created_at
  from public.board_invites i
  join public.boards b on b.id = i.board_id
  join public.profiles p on p.id = i.invited_by
  where i.email is not null and lower(i.email) = public.current_email()
  order by i.created_at;
$$;

create or replace function public.accept_invite(p_invite uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite public.board_invites;
begin
  select * into v_invite from public.board_invites
  where id = p_invite and email is not null and lower(email) = public.current_email();
  if not found then
    raise exception 'Invitation not found' using errcode = 'P0002';
  end if;
  insert into public.board_members (board_id, user_id, role)
  values (v_invite.board_id, auth.uid(), v_invite.role)
  on conflict (board_id, user_id) do nothing;
  delete from public.board_invites where id = v_invite.id;
  return v_invite.board_id;
end;
$$;

create or replace function public.decline_invite(p_invite uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.board_invites
  where id = p_invite and email is not null and lower(email) = public.current_email();
$$;

create or replace function public.join_board_with_link(p_token text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite public.board_invites;
begin
  if auth.uid() is null then
    raise exception 'Sign in to join a board' using errcode = '42501';
  end if;
  select * into v_invite from public.board_invites where token = p_token;
  if not found then
    raise exception 'This invite link is no longer valid' using errcode = 'P0002';
  end if;
  insert into public.board_members (board_id, user_id, role)
  values (v_invite.board_id, auth.uid(), v_invite.role)
  on conflict (board_id, user_id) do nothing;
  return v_invite.board_id;
end;
$$;

create or replace function public.create_invite_link(p_board text, p_role text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if public.board_role(p_board) is distinct from 'owner' then
    raise exception 'Only the board owner can create invite links' using errcode = '42501';
  end if;
  if p_role not in ('editor', 'viewer') then
    raise exception 'Invalid role' using errcode = '22023';
  end if;
  insert into public.board_invites (board_id, token, role, invited_by)
  values (p_board, v_token, p_role, auth.uid());
  return v_token;
end;
$$;

revoke execute on function public.my_invites(), public.accept_invite(uuid), public.decline_invite(uuid),
  public.join_board_with_link(text), public.create_invite_link(text, text) from public, anon;
grant execute on function public.my_invites(), public.accept_invite(uuid), public.decline_invite(uuid),
  public.join_board_with_link(text), public.create_invite_link(text, text) to authenticated;

-- Live updates: clients listen for board changes and their own memberships.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.boards, public.board_members;
  end if;
end;
$$;
