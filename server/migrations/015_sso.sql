-- Sign-in with an OpenID Connect provider (SSO). People who only ever sign in
-- with SSO have no password, so password_hash becomes optional.
alter table kanban.users alter column password_hash drop not null;

-- Which SSO account (issuer + subject) belongs to which app account. Linked on
-- first SSO sign-in by verified email, then found by subject from then on.
create table kanban.user_identities (
  issuer text not null,
  subject text not null,
  user_id uuid not null references kanban.users (id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now(),
  last_sign_in_at timestamptz not null default now(),
  primary key (issuer, subject)
);
create index user_identities_user_id_idx on kanban.user_identities (user_id);
