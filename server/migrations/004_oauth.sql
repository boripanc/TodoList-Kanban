-- OAuth 2.1 for MCP clients such as Claude's custom connectors: clients
-- register themselves, people sign in and allow access, and the client gets
-- short-lived access tokens plus a refresh token. Only hashes are stored.

create table kanban.oauth_clients (
  id text primary key,
  secret_hash text,
  name text not null,
  redirect_uris jsonb not null,
  created_at timestamptz not null default now()
);

-- Who allowed which client. Removing a row disconnects the client.
create table kanban.oauth_grants (
  user_id uuid not null references kanban.users (id) on delete cascade,
  client_id text not null references kanban.oauth_clients (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  primary key (user_id, client_id)
);

create table kanban.oauth_codes (
  code_hash text primary key,
  client_id text not null references kanban.oauth_clients (id) on delete cascade,
  user_id uuid not null references kanban.users (id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  scope text not null,
  expires_at timestamptz not null
);

create table kanban.oauth_tokens (
  token_hash text primary key,
  kind text not null check (kind in ('access', 'refresh')),
  user_id uuid not null,
  client_id text not null,
  scope text not null,
  expires_at timestamptz not null,
  foreign key (user_id, client_id) references kanban.oauth_grants (user_id, client_id) on delete cascade
);
create index oauth_tokens_grant_idx on kanban.oauth_tokens (user_id, client_id);
