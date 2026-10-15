-- Card rules per competition and manual suspensions.
-- Automatic bans from cards are derived on each device (shared/src/discipline.ts).

alter table competitions
  add column yellow_card_limit int not null default 3 check (yellow_card_limit between 0 and 20),
  add column red_card_ban int not null default 1 check (red_card_ban between 0 and 20),
  add column second_yellow_ban int not null default 1 check (second_yellow_ban between 0 and 20);

-- Give existing competitions a new server_seq so devices pull the new columns.
update competitions set updated_at = now();

create table suspensions (
  id uuid primary key,
  federation_id uuid not null references federations(id),
  player_id uuid not null references players(id),
  competition_id uuid references competitions(id),
  matches int check (matches between 1 and 50),
  starts_on date not null,
  ends_on date,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  server_seq bigint not null default 0,
  -- Either N matches in one competition, or a date range (every competition).
  check ((matches is not null and competition_id is not null and ends_on is null)
      or (matches is null and ends_on is not null and ends_on >= starts_on))
);
create index suspensions_player_idx on suspensions (player_id);
create index suspensions_seq_idx on suspensions (federation_id, server_seq);
create trigger suspensions_touch before insert or update on suspensions
  for each row execute function sync_touch();
