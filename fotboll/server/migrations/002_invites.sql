-- One-time links for invitations and password resets.
--
-- An invited user is created with password_hash '!' (no password can match it)
-- and chooses a password through the link. Only a hash of the token is stored;
-- a token works once and expires.

create table auth_tokens (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  purpose text not null check (purpose in ('invite', 'reset')),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index auth_tokens_user_idx on auth_tokens (user_id);
