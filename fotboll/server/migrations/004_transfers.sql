-- Transfers between clubs. The receiving club applies, the current club
-- releases the player, and only then the federation can approve:
--
--   pending_club ──(current club releases)──▶ pending_federation ──(federation)──▶ approved
--        │                                          │
--        └──── rejected / cancelled ◀───────────────┘
--
-- A player without a club skips the release step. On approval the server
-- moves the player (see sync/rules.ts).

create table transfers (
  id uuid primary key,
  federation_id uuid not null references federations(id),
  player_id uuid not null references players(id),
  from_club_id uuid references clubs(id),
  to_club_id uuid not null references clubs(id),
  status text not null default 'pending_club'
    check (status in ('pending_club', 'pending_federation', 'approved', 'rejected', 'cancelled')),
  note text,
  response_note text,
  requested_by uuid references users(id),
  released_by uuid references users(id),
  released_at timestamptz,
  decided_by uuid references users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  server_seq bigint not null default 0
);
-- One open transfer per player at a time.
create unique index transfers_one_open on transfers (player_id)
  where status in ('pending_club', 'pending_federation') and deleted_at is null;
create index transfers_clubs_idx on transfers (from_club_id, to_club_id);
create index transfers_seq_idx on transfers (federation_id, server_seq);
create trigger transfers_touch before insert or update on transfers
  for each row execute function sync_touch();
