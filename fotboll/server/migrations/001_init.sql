-- Football administration: initial schema.
--
-- Every replicated table carries the same sync columns. server_seq is drawn
-- from one global sequence by a trigger; writers hold an advisory lock for
-- the whole transaction (see db.ts: withWriteLock), so sequence order is
-- commit order and an incremental pull (server_seq > cursor) never skips a row.

create sequence sync_seq;

create function sync_touch() returns trigger language plpgsql as $$
begin
  new.server_seq := nextval('sync_seq');
  new.updated_at := now();
  return new;
end $$;

-- ── Organisation & access (users are managed online by federation admins) ──

create table federations (
  id uuid primary key,
  name text not null,
  country text,
  default_locale text not null default 'so' check (default_locale in ('so', 'en', 'ar')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  server_seq bigint not null default 0
);

create table users (
  id uuid primary key,
  federation_id uuid not null references federations(id),
  email text not null,
  password_hash text not null,
  display_name text not null,
  locale text not null default 'so' check (locale in ('so', 'en', 'ar')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  server_seq bigint not null default 0
);
create unique index users_email_key on users (lower(email));

create table clubs (
  id uuid primary key,
  federation_id uuid not null references federations(id),
  name text not null,
  short_name text,
  city text,
  logo_media_id uuid,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  server_seq bigint not null default 0
);

create table role_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('federation_admin', 'club_admin', 'referee')),
  club_id uuid references clubs(id),
  created_at timestamptz not null default now(),
  check ((role = 'club_admin') = (club_id is not null))
);
create unique index role_assignments_unique
  on role_assignments (user_id, role, coalesce(club_id, '00000000-0000-0000-0000-000000000000'));

create table sessions (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sessions_user_idx on sessions (user_id);

-- ── Registry ──

create table media (
  id uuid primary key,
  federation_id uuid not null references federations(id),
  kind text not null check (kind in ('player_photo', 'club_logo')),
  sha256 text not null,
  mime text not null,
  width int not null,
  height int not null,
  upload_status text not null default 'pending' check (upload_status in ('pending', 'done')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  server_seq bigint not null default 0
);

create table players (
  id uuid primary key,
  federation_id uuid not null references federations(id),
  club_id uuid references clubs(id),
  first_name text not null,
  last_name text not null,
  name_alt text,
  birth_date date not null,
  gender text not null check (gender in ('male', 'female')),
  photo_media_id uuid references media(id),
  photo_consent boolean not null default false,
  license_no text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  server_seq bigint not null default 0
);
create index players_club_idx on players (club_id);

create table seasons (
  id uuid primary key,
  federation_id uuid not null references federations(id),
  name text not null,
  starts_on date not null,
  ends_on date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  server_seq bigint not null default 0
);

create table registrations (
  id uuid primary key,
  federation_id uuid not null references federations(id),
  player_id uuid not null references players(id),
  club_id uuid not null references clubs(id),
  season_id uuid not null references seasons(id),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  note text,
  decided_by uuid references users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  server_seq bigint not null default 0
);

-- ── Competition ──

create table competitions (
  id uuid primary key,
  federation_id uuid not null references federations(id),
  season_id uuid not null references seasons(id),
  name text not null,
  name_i18n jsonb,
  age_group text,
  gender text not null default 'male' check (gender in ('male', 'female', 'mixed')),
  points_win int not null default 3,
  points_draw int not null default 1,
  points_loss int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  server_seq bigint not null default 0
);

create table teams (
  id uuid primary key,
  federation_id uuid not null references federations(id),
  club_id uuid not null references clubs(id),
  competition_id uuid not null references competitions(id),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  server_seq bigint not null default 0
);

create table squad_members (
  id uuid primary key,
  federation_id uuid not null references federations(id),
  team_id uuid not null references teams(id),
  player_id uuid not null references players(id),
  shirt_number int,
  position text check (position in ('GK', 'DF', 'MF', 'FW')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  server_seq bigint not null default 0
);
create unique index squad_members_unique on squad_members (team_id, player_id) where deleted_at is null;

create table venues (
  id uuid primary key,
  federation_id uuid not null references federations(id),
  name text not null,
  address text,
  lat double precision,
  lng double precision,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  server_seq bigint not null default 0
);

create table matches (
  id uuid primary key,
  federation_id uuid not null references federations(id),
  competition_id uuid not null references competitions(id),
  round int not null,
  home_team_id uuid not null references teams(id),
  away_team_id uuid not null references teams(id),
  venue_id uuid references venues(id),
  kickoff_at timestamptz not null,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'played', 'postponed', 'cancelled')),
  referee_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  server_seq bigint not null default 0,
  check (home_team_id <> away_team_id)
);
create index matches_referee_idx on matches (referee_user_id);

-- ── Match report ──

create table match_reports (
  id uuid primary key references matches(id),
  federation_id uuid not null references federations(id),
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'reopened')),
  home_score int not null default 0,
  away_score int not null default 0,
  notes text,
  submitted_at timestamptz,
  submitted_by uuid references users(id),
  approved_at timestamptz,
  approved_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  server_seq bigint not null default 0
);

create table match_lineups (
  id uuid primary key,
  federation_id uuid not null references federations(id),
  match_id uuid not null references matches(id),
  team_id uuid not null references teams(id),
  player_id uuid not null references players(id),
  shirt_number int,
  is_starter boolean not null default true,
  is_captain boolean not null default false,
  is_goalkeeper boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  server_seq bigint not null default 0
);
create unique index match_lineups_unique on match_lineups (match_id, player_id) where deleted_at is null;

create table match_events (
  id uuid primary key,
  federation_id uuid not null references federations(id),
  match_id uuid not null references matches(id),
  team_id uuid not null references teams(id),
  player_id uuid references players(id),
  related_player_id uuid references players(id),
  type text not null
    check (type in ('goal', 'penalty_goal', 'own_goal', 'yellow', 'second_yellow', 'red', 'sub')),
  minute int not null,
  added_time int,
  recorded_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  server_seq bigint not null default 0
);
create index match_events_match_idx on match_events (match_id);

-- ── Sync bookkeeping ──

-- Results of processed mutations, so a retried push is answered without re-applying.
create table applied_mutations (
  user_id uuid not null references users(id) on delete cascade,
  id uuid not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- Concurrent edits to the same row: the later patch wins field by field,
-- and the overwritten version is kept here for admins to review.
create table conflict_log (
  id bigserial primary key,
  table_name text not null,
  row_id uuid not null,
  user_id uuid not null,
  base_seq bigint,
  current_seq bigint not null,
  previous jsonb not null,
  patch jsonb not null,
  created_at timestamptz not null default now()
);

-- Seq indexes and touch triggers for every replicated table.
do $$
declare t text;
begin
  foreach t in array array[
    'users', 'clubs', 'media', 'players', 'seasons', 'registrations',
    'competitions', 'teams', 'squad_members', 'venues', 'matches',
    'match_reports', 'match_lineups', 'match_events'
  ] loop
    execute format('create index %I on %I (federation_id, server_seq)', t || '_seq_idx', t);
  end loop;
  foreach t in array array[
    'federations', 'users', 'clubs', 'media', 'players', 'seasons', 'registrations',
    'competitions', 'teams', 'squad_members', 'venues', 'matches',
    'match_reports', 'match_lineups', 'match_events'
  ] loop
    execute format(
      'create trigger %I before insert or update on %I for each row execute function sync_touch()',
      t || '_touch', t);
  end loop;
end $$;
