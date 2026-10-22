-- Personal address book and credentials vault. Each row belongs to one user.

create table kanban.contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references kanban.users (id) on delete cascade,
  name text not null,
  company text not null default '',
  job_title text not null default '',
  email text not null default '',
  phone text not null default '',
  website text not null default '',
  address text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index contacts_user_id_idx on kanban.contacts (user_id);

-- Non-secret fields are kept as JSON; secret values and notes are encrypted
-- together (AES-256-GCM) in "secret", by server/src/vault.ts.
create table kanban.credentials (
  id uuid primary key,
  user_id uuid not null references kanban.users (id) on delete cascade,
  name text not null,
  kind text not null,
  url text not null default '',
  fields jsonb not null default '[]'::jsonb,
  secret text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index credentials_user_id_idx on kanban.credentials (user_id);

-- Used only when the server has no CREDENTIALS_KEY: a generated key, so secrets
-- are still encrypted at rest, though the key sits in the same database.
create table kanban.vault_keys (
  id text primary key,
  key text not null,
  created_at timestamptz not null default now()
);
