-- Team sheets: a club submits its lineup for a match, so the referee, the
-- opponent and the federation can see it. Changing the lineup afterwards
-- (as the club) sets the sheet back to draft until it is submitted again.

create table team_sheets (
  id uuid primary key,
  federation_id uuid not null references federations(id),
  match_id uuid not null references matches(id),
  team_id uuid not null references teams(id),
  status text not null default 'draft' check (status in ('draft', 'submitted')),
  submitted_at timestamptz,
  submitted_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  server_seq bigint not null default 0
);
create unique index team_sheets_unique on team_sheets (match_id, team_id) where deleted_at is null;
create index team_sheets_seq_idx on team_sheets (federation_id, server_seq);
create trigger team_sheets_touch before insert or update on team_sheets
  for each row execute function sync_touch();

-- Lineups carry the player's name, so everyone who sees a lineup can read it
-- without getting the player's other personal data.
alter table match_lineups add column player_name text;
update match_lineups l set player_name = p.first_name || ' ' || p.last_name
from players p where p.id = l.player_id;
