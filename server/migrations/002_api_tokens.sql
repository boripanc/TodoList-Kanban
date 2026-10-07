-- Personal API tokens: let automation tools such as n8n act as a user through
-- the REST API and the MCP endpoint, with that user's roles on each board.
-- Only a hash of each token is stored; the token itself is shown once.

create table kanban.api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references kanban.users (id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index api_tokens_user_id_idx on kanban.api_tokens (user_id);
