-- BTOWN PARTY — backend for the live social-mixer platform. 2026-08-09.
-- Paste this WHOLE file into the Supabase SQL Editor (same btown-games
-- project as the leaderboard and the game rooms) and click Run. Safe to
-- re-run. Brand-new party_* tables and functions only — nothing here
-- touches the games, the rooms layer, or caption-this.
--
-- The model: an event is a 4-letter code Stephen creates from his phone
-- (his host key never leaves his phone un-hashed). Attendees join with a
-- first name, answer tonight's check-in questions privately, and later
-- send tiny per-round submissions. The host closes each round, approves or
-- rejects every submission, and paces a staged reveal step by step; the
-- big screen polls a read-only view of it all.
--
-- THE RULE THE WHOLE SCHEMA SERVES: nothing an attendee typed ever reaches
-- the unauthenticated screen view until the host approved it. Submissions
-- are born 'pending'; party_screen_get exposes only host-stored results
-- and counts, and party_start_reveal auto-rejects anything still pending.
--
-- Security model matches the rooms layer: RLS locks every table; the
-- public anon key can ONLY go through the security-definer functions
-- below. Host keys and device tokens are stored hashed (sha256), so a
-- leaked row can't impersonate anyone. Events self-expire after 24 hours
-- (swept opportunistically — no cron). This file is mirrored one-for-one
-- by js/party-core.js in the btown-party repo: same ops, same error
-- codes, same shapes. Change them together.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- tables

create table if not exists public.party_events (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z2-9]{4}$'),
  host_key_hash text not null,
  title text not null default '' check (length(title) <= 80),
  questions jsonb not null,        -- [{id, text, options[]}] host-picked
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.party_players (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.party_events(id) on delete cascade,
  name text not null check (length(name) between 1 and 24),
  token_hash text not null,
  checkin jsonb not null default '{}'::jsonb,  -- {question_id: option_index}
  joined_at timestamptz not null default now(),
  last_seen bigint not null default 0,         -- unix seconds, throttled
  unique (event_id, token_hash)
);
create index if not exists party_players_event on public.party_players (event_id);

create table if not exists public.party_rounds (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.party_events(id) on delete cascade,
  mode text not null check (mode ~ '^[a-z0-9-]{1,40}$'),
  config jsonb not null default '{}'::jsonb,
  status text not null default 'collecting'
    check (status in ('collecting', 'moderating', 'revealing', 'done')),
  reveal_step int not null default -1 check (reveal_step between -1 and 40),
  results jsonb,                   -- host-computed reveal, moderated inputs only
  created_at timestamptz not null default now()
);
create index if not exists party_rounds_event on public.party_rounds (event_id, created_at);
-- one live round per event, enforced by the database itself
create unique index if not exists party_rounds_one_live
  on public.party_rounds (event_id) where status <> 'done';

create table if not exists public.party_submissions (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.party_rounds(id) on delete cascade,
  player_id uuid not null references public.party_players(id) on delete cascade,
  name text not null,              -- the first name as it was when they sent it
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'held')),
  created_at timestamptz not null default now(),
  unique (round_id, player_id)     -- one entry per phone per round (upsert)
);
create index if not exists party_submissions_round on public.party_submissions (round_id);

create table if not exists public.party_votes (
  round_id uuid not null references public.party_rounds(id) on delete cascade,
  player_id uuid not null references public.party_players(id) on delete cascade,
  target text not null check (length(target) between 1 and 64),
  value int not null check (value between -10 and 10),
  created_at timestamptz not null default now(),
  primary key (round_id, player_id, target)
);

alter table public.party_events enable row level security;
alter table public.party_players enable row level security;
alter table public.party_rounds enable row level security;
alter table public.party_submissions enable row level security;
alter table public.party_votes enable row level security;
revoke all on table public.party_events from anon, authenticated;
revoke all on table public.party_players from anon, authenticated;
revoke all on table public.party_rounds from anon, authenticated;
revoke all on table public.party_submissions from anon, authenticated;
revoke all on table public.party_votes from anon, authenticated;

-- --------------------------------------------------------------- helpers

create or replace function public.bp_hash(p text) returns text
language sql immutable as $$
  select encode(extensions.digest(coalesce(p, ''), 'sha256'), 'hex');
$$;

create or replace function public.bp_clean_name(p_name text) returns text
language sql immutable as $$
  select left(btrim(regexp_replace(coalesce(p_name, ''), '[\x00-\x1f\x7f]', '', 'g')), 24);
$$;

create or replace function public.bp_check_identity(p_secret text) returns void
language plpgsql immutable as $$
begin
  if coalesce(length(p_secret), 0) not between 8 and 64 then
    raise exception using message = 'bad_identity';
  end if;
end;
$$;

-- Mirrors validateQuestions() in party-core.js.
create or replace function public.bp_check_questions(p_questions jsonb) returns void
language plpgsql immutable as $$
declare
  q jsonb;
  o jsonb;
  n int;
  seen text[] := '{}';
begin
  if p_questions is null or jsonb_typeof(p_questions) <> 'array' then
    raise exception using message = 'bad_questions';
  end if;
  n := jsonb_array_length(p_questions);
  if n < 1 or n > 8 then
    raise exception using message = 'bad_questions';
  end if;
  if pg_column_size(p_questions) > 8192 then
    raise exception using message = 'questions_too_big';
  end if;
  for q in select * from jsonb_array_elements(p_questions) loop
    if coalesce(q->>'id', '') !~ '^[a-z0-9-]{1,40}$'
       or (q->>'id') = any(seen)
       or coalesce(btrim(q->>'text'), '') = ''
       or length(q->>'text') > 200
       or jsonb_typeof(q->'options') <> 'array'
       or jsonb_array_length(q->'options') not between 2 and 6 then
      raise exception using message = 'bad_questions';
    end if;
    seen := seen || (q->>'id');
    for o in select * from jsonb_array_elements(q->'options') loop
      if jsonb_typeof(o) <> 'string' or coalesce(btrim(o #>> '{}'), '') = ''
         or length(o #>> '{}') > 60 then
        raise exception using message = 'bad_questions';
      end if;
    end loop;
  end loop;
end;
$$;

-- Events are ephemeral: sweep anything older than a day (players, rounds,
-- submissions, and votes follow by cascade). Called opportunistically from
-- party_create_event and party_join — zero maintenance.
create or replace function public.bp_sweep() returns void
language sql security definer set search_path = public as $$
  delete from public.party_events where created_at < now() - interval '24 hours';
$$;

-- Hard budget, same spirit as the rooms cap: a key-scraping spammer can't
-- grow the tables no matter how many identities they rotate through.
create or replace function public.bp_check_budget() returns void
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.party_events) >= 500 then
    raise exception using message = 'party_over_capacity';
  end if;
end;
$$;

create or replace function public.bp_event_by_code(p_code text)
returns public.party_events
language plpgsql security definer set search_path = public as $$
declare e public.party_events%rowtype;
begin
  select * into e from party_events
  where code = upper(btrim(coalesce(p_code, '')));
  if not found then
    raise exception using message = 'not_found';
  end if;
  return e;
end;
$$;

create or replace function public.bp_require_host(p_event uuid, p_host_key text)
returns public.party_events
language plpgsql security definer set search_path = public as $$
declare e public.party_events%rowtype;
begin
  select * into e from party_events where id = p_event;
  if not found then
    raise exception using message = 'not_found';
  end if;
  if e.host_key_hash <> public.bp_hash(p_host_key) then
    raise exception using message = 'not_host';
  end if;
  return e;
end;
$$;

create or replace function public.bp_require_player(p_event uuid, p_token text)
returns public.party_players
language plpgsql security definer set search_path = public as $$
declare p public.party_players%rowtype;
begin
  select * into p from party_players
  where event_id = p_event and token_hash = public.bp_hash(p_token);
  if not found then
    raise exception using message = 'not_joined';
  end if;
  return p;
end;
$$;

-- The event's live round, or null. The partial unique index guarantees at
-- most one exists.
create or replace function public.bp_live_round(p_event uuid)
returns public.party_rounds
language sql security definer set search_path = public as $$
  select * from party_rounds where event_id = p_event and status <> 'done';
$$;

-- Anonymous per-option counts for one check-in question. Only aggregates
-- leave this function — no answer is attributable to a name.
create or replace function public.bp_tally(p_event uuid, p_question jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  n int := jsonb_array_length(p_question->'options');
  counts int[];
  total int := 0;
  a text;
begin
  counts := array_fill(0, array[n]);
  for a in
    select p.checkin->>(p_question->>'id') from party_players p
    where p.event_id = p_event and p.checkin ? (p_question->>'id')
  loop
    if a ~ '^[0-9]+$' and a::int >= 0 and a::int < n then
      counts[a::int + 1] := counts[a::int + 1] + 1;
      total := total + 1;
    end if;
  end loop;
  return jsonb_build_object(
    'questionId', p_question->>'id',
    'counts', to_jsonb(counts),
    'total', total);
end;
$$;

create or replace function public.bp_tallies(p_event uuid) returns jsonb
language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(public.bp_tally(p_event, q)), '[]'::jsonb)
  from party_events e, jsonb_array_elements(e.questions) q
  where e.id = p_event;
$$;

-- Results of finished rounds, oldest first — feeds the running scoreboard.
create or replace function public.bp_done_results(p_event uuid, p_with_id boolean)
returns jsonb
language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(
    case when p_with_id
      then jsonb_build_object('id', r.id, 'mode', r.mode, 'results', r.results)
      else jsonb_build_object('mode', r.mode, 'results', r.results)
    end order by r.created_at), '[]'::jsonb)
  from party_rounds r
  where r.event_id = p_event and r.status = 'done' and r.results is not null;
$$;

-- ------------------------------------------------------------ player RPCs

-- Host opens tonight's event from his phone. His previous open event (last
-- week's) closes automatically — one live event per host key.
create or replace function public.party_create_event(
  p_host_key text, p_questions jsonb, p_title text default ''
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_code text;
  v_id uuid;
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_try int := 0;
begin
  perform public.bp_check_identity(p_host_key);
  perform public.bp_check_questions(p_questions);
  perform public.bp_sweep();
  perform public.bp_check_budget();

  update party_events set status = 'closed', updated_at = now()
  where host_key_hash = public.bp_hash(p_host_key) and status = 'open';

  loop
    v_try := v_try + 1;
    v_code := '';
    for i in 1..4 loop
      v_code := v_code || substr(v_alphabet,
        1 + (get_byte(extensions.gen_random_bytes(1), 0) % 31), 1);
    end loop;
    begin
      insert into party_events (code, host_key_hash, title, questions)
      values (v_code, public.bp_hash(p_host_key),
              left(btrim(coalesce(p_title, '')), 80), p_questions)
      returning id into v_id;
      exit;
    exception when unique_violation then
      if v_try >= 20 then
        raise exception using message = 'no_codes_left';
      end if;
    end;
  end loop;

  return jsonb_build_object('eventId', v_id, 'code', v_code);
end;
$$;

-- Attendee joins with a first name. Rejoining with the same device token
-- never burns a second chair; a new non-blank name fixes a typo.
create or replace function public.party_join(
  p_code text, p_name text, p_token text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  e public.party_events%rowtype;
  p public.party_players%rowtype;
  v_name text;
begin
  perform public.bp_check_identity(p_token);
  if upper(btrim(coalesce(p_code, ''))) !~ '^[A-Z2-9]{4}$' then
    raise exception using message = 'bad_code';
  end if;
  perform public.bp_sweep();
  e := public.bp_event_by_code(p_code);
  if e.status <> 'open' then
    raise exception using message = 'event_closed';
  end if;

  select * into p from party_players
  where event_id = e.id and token_hash = public.bp_hash(p_token);
  if found then
    v_name := public.bp_clean_name(p_name);
    if v_name <> '' and v_name <> p.name then
      update party_players set name = v_name where id = p.id;
      p.name := v_name;
    end if;
    update party_players set last_seen = extract(epoch from now())::bigint
    where id = p.id;
  else
    v_name := public.bp_clean_name(p_name);
    if v_name = '' then
      raise exception using message = 'bad_name';
    end if;
    if (select count(*) from party_players where event_id = e.id) >= 200 then
      raise exception using message = 'event_full';
    end if;
    insert into party_players (event_id, name, token_hash, last_seen)
    values (e.id, v_name, public.bp_hash(p_token), extract(epoch from now())::bigint)
    returning * into p;
    update party_events set updated_at = now() where id = e.id;
  end if;

  return jsonb_build_object(
    'eventId', e.id, 'playerId', p.id, 'name', p.name, 'title', e.title,
    'questions', e.questions,
    'checkinDone', p.checkin <> '{}'::jsonb);
end;
$$;

-- Save check-in answers. Porous on purpose: none, some, or all is fine;
-- unknown question ids are dropped, out-of-range picks are refused.
create or replace function public.party_checkin(
  p_event uuid, p_token text, p_answers jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  e public.party_events%rowtype;
  p public.party_players%rowtype;
  k text;
  v jsonb;
  q jsonb;
  cleaned jsonb := '{}'::jsonb;
begin
  select * into e from party_events where id = p_event;
  if not found then
    raise exception using message = 'not_found';
  end if;
  if e.status <> 'open' then
    raise exception using message = 'event_closed';
  end if;
  p := public.bp_require_player(p_event, p_token);
  if p_answers is null or jsonb_typeof(p_answers) <> 'object'
     or pg_column_size(p_answers) > 2048 then
    raise exception using message = 'bad_answers';
  end if;
  for k, v in select * from jsonb_each(p_answers) loop
    select question into q from jsonb_array_elements(e.questions) question
    where question->>'id' = k;
    if q is null then
      continue;  -- unknown ids are dropped, not fatal
    end if;
    if jsonb_typeof(v) <> 'number' or (v #>> '{}') !~ '^[0-9]+$'
       or (v #>> '{}')::int >= jsonb_array_length(q->'options') then
      raise exception using message = 'bad_answers';
    end if;
    cleaned := cleaned || jsonb_build_object(k, v);
  end loop;
  update party_players
  set checkin = checkin || cleaned,
      last_seen = extract(epoch from now())::bigint
  where id = p.id;
  update party_events set updated_at = now() where id = p_event;
  return jsonb_build_object('ok', true,
    'answered', (select count(*) from jsonb_object_keys((select checkin from party_players where id = p.id))));
end;
$$;

-- The attendee poll (~2.5s). Deliberately small and deliberately blind:
-- no roster, no other phones' inputs, no results — the reveal belongs to
-- the room, not this screen.
create or replace function public.party_player_get(p_event uuid, p_token text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  e public.party_events%rowtype;
  p public.party_players%rowtype;
  r public.party_rounds%rowtype;
  v_now bigint := extract(epoch from now())::bigint;
begin
  select * into e from party_events where id = p_event;
  if not found then
    raise exception using message = 'not_found';
  end if;
  p := public.bp_require_player(p_event, p_token);
  if v_now - p.last_seen > 15 then
    update party_players set last_seen = v_now where id = p.id;
  end if;
  r := public.bp_live_round(p_event);
  return jsonb_build_object(
    'status', e.status, 'title', e.title, 'name', p.name,
    'checkinDone', p.checkin <> '{}'::jsonb,
    'round', case when r.id is null then null else jsonb_build_object(
      'id', r.id, 'mode', r.mode, 'status', r.status,
      'config', case when r.status = 'collecting' then r.config else null end,
      'submitted', exists (select 1 from party_submissions
                           where round_id = r.id and player_id = p.id)
    ) end);
end;
$$;

-- One tiny submission per phone per round, while the round is collecting.
-- Re-submitting replaces your entry AND sends it back to 'pending' — an
-- edit can never ride an earlier approval past the host.
create or replace function public.party_submit(
  p_event uuid, p_token text, p_round uuid, p_payload jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p public.party_players%rowtype;
  r public.party_rounds%rowtype;
begin
  p := public.bp_require_player(p_event, p_token);
  r := public.bp_live_round(p_event);
  if r.id is null or r.id <> p_round or r.status <> 'collecting' then
    raise exception using message = 'round_closed';
  end if;
  if p_payload is null or pg_column_size(p_payload) > 2048 then
    raise exception using message = 'bad_payload';
  end if;
  insert into party_submissions (round_id, player_id, name, payload)
  values (r.id, p.id, p.name, p_payload)
  on conflict (round_id, player_id) do update
    set payload = excluded.payload, name = excluded.name,
        status = 'pending', created_at = now();
  update party_players set last_seen = extract(epoch from now())::bigint
  where id = p.id;
  update party_events set updated_at = now() where id = p_event;
  return jsonb_build_object('ok', true);
end;
$$;

-- Generic per-round vote for future modes (Room Knows doesn't use it).
create or replace function public.party_vote(
  p_event uuid, p_token text, p_round uuid, p_target text, p_value int
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p public.party_players%rowtype;
  r public.party_rounds%rowtype;
begin
  p := public.bp_require_player(p_event, p_token);
  r := public.bp_live_round(p_event);
  if r.id is null or r.id <> p_round or r.status = 'done' then
    raise exception using message = 'round_closed';
  end if;
  if coalesce(btrim(p_target), '') = '' or length(p_target) > 64
     or p_value is null or abs(p_value) > 10 then
    raise exception using message = 'bad_vote';
  end if;
  if (select count(*) from party_votes
      where round_id = r.id and player_id = p.id) >= 40 then
    raise exception using message = 'too_many_votes';
  end if;
  insert into party_votes (round_id, player_id, target, value)
  values (r.id, p.id, p_target, p_value)
  on conflict (round_id, player_id, target) do update set value = excluded.value;
  update party_events set updated_at = now() where id = p_event;
  return jsonb_build_object('ok', true);
end;
$$;

-- -------------------------------------------------------------- host RPCs

create or replace function public.party_open_round(
  p_event uuid, p_host_key text, p_mode text, p_config jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  e public.party_events%rowtype;
  v_id uuid;
begin
  e := public.bp_require_host(p_event, p_host_key);
  if e.status <> 'open' then
    raise exception using message = 'event_closed';
  end if;
  if (public.bp_live_round(p_event)).id is not null then
    raise exception using message = 'round_in_progress';
  end if;
  if (select count(*) from party_rounds where event_id = p_event) >= 50 then
    raise exception using message = 'too_many_rounds';
  end if;
  if coalesce(p_mode, '') !~ '^[a-z0-9-]{1,40}$' then
    raise exception using message = 'bad_mode';
  end if;
  if p_config is not null and pg_column_size(p_config) > 8192 then
    raise exception using message = 'config_too_big';
  end if;
  insert into party_rounds (event_id, mode, config)
  values (p_event, p_mode, coalesce(p_config, '{}'::jsonb))
  returning id into v_id;
  update party_events set updated_at = now() where id = p_event;
  return jsonb_build_object('roundId', v_id);
end;
$$;

create or replace function public.party_close_round(p_event uuid, p_host_key text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.party_rounds%rowtype;
begin
  perform public.bp_require_host(p_event, p_host_key);
  r := public.bp_live_round(p_event);
  if r.id is null or r.status <> 'collecting' then
    raise exception using message = 'bad_phase';
  end if;
  update party_rounds set status = 'moderating' where id = r.id;
  update party_events set updated_at = now() where id = p_event;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.party_moderate(
  p_event uuid, p_host_key text, p_submission uuid, p_status text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.party_rounds%rowtype;
begin
  perform public.bp_require_host(p_event, p_host_key);
  if p_status not in ('approved', 'rejected', 'held') then
    raise exception using message = 'bad_status';
  end if;
  r := public.bp_live_round(p_event);
  if r.id is null or r.status not in ('collecting', 'moderating') then
    raise exception using message = 'bad_phase';
  end if;
  update party_submissions set status = p_status
  where id = p_submission and round_id = r.id;
  if not found then
    raise exception using message = 'not_found';
  end if;
  update party_events set updated_at = now() where id = p_event;
  return jsonb_build_object('ok', true);
end;
$$;

-- The host's one-tap "approve the rest" (or reject the rest) — a bulk
-- verdict for everything still pending in the live round.
create or replace function public.party_moderate_all(
  p_event uuid, p_host_key text, p_round uuid, p_status text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r public.party_rounds%rowtype;
  n int;
begin
  perform public.bp_require_host(p_event, p_host_key);
  if p_status not in ('approved', 'rejected', 'held') then
    raise exception using message = 'bad_status';
  end if;
  r := public.bp_live_round(p_event);
  if r.id is null or r.id <> p_round
     or r.status not in ('collecting', 'moderating') then
    raise exception using message = 'bad_phase';
  end if;
  update party_submissions set status = p_status
  where round_id = r.id and status = 'pending';
  get diagnostics n = row_count;
  update party_events set updated_at = now() where id = p_event;
  return jsonb_build_object('changed', n);
end;
$$;

-- The host console computed the round's results (with the mode's pure
-- logic, over APPROVED submissions only) and stores them here to be
-- revealed. The moderation gate is enforced, not trusted: anything still
-- pending is rejected on the spot, so an unmoderated entry can never ride
-- into a reveal.
create or replace function public.party_start_reveal(
  p_event uuid, p_host_key text, p_round uuid, p_results jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.party_rounds%rowtype;
begin
  perform public.bp_require_host(p_event, p_host_key);
  r := public.bp_live_round(p_event);
  if r.id is null or r.id <> p_round
     or r.status not in ('collecting', 'moderating') then
    raise exception using message = 'bad_phase';
  end if;
  if p_results is null or pg_column_size(p_results) > 32768 then
    raise exception using message = 'bad_results';
  end if;
  update party_submissions set status = 'rejected'
  where round_id = r.id and status = 'pending';
  update party_rounds
  set results = p_results, status = 'revealing', reveal_step = 0
  where id = r.id;
  update party_events set updated_at = now() where id = p_event;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.party_reveal_step(
  p_event uuid, p_host_key text, p_round uuid, p_step int
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.party_rounds%rowtype;
begin
  perform public.bp_require_host(p_event, p_host_key);
  r := public.bp_live_round(p_event);
  if r.id is null or r.id <> p_round or r.status <> 'revealing' then
    raise exception using message = 'bad_phase';
  end if;
  if p_step is null or p_step < 0 or p_step > 40 then
    raise exception using message = 'bad_step';
  end if;
  update party_rounds set reveal_step = p_step where id = r.id;
  update party_events set updated_at = now() where id = p_event;
  return jsonb_build_object('step', p_step);
end;
$$;

-- Ending an unrevealed round scraps it: its submissions die unseen.
create or replace function public.party_end_round(p_event uuid, p_host_key text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.party_rounds%rowtype;
begin
  perform public.bp_require_host(p_event, p_host_key);
  r := public.bp_live_round(p_event);
  if r.id is null then
    raise exception using message = 'bad_phase';
  end if;
  update party_rounds set status = 'done' where id = r.id;
  update party_events set updated_at = now() where id = p_event;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.party_remove_player(
  p_event uuid, p_host_key text, p_player uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform public.bp_require_host(p_event, p_host_key);
  delete from party_players where id = p_player and event_id = p_event;
  if not found then
    raise exception using message = 'not_found';
  end if;
  update party_events set updated_at = now() where id = p_event;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.party_close_event(p_event uuid, p_host_key text)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform public.bp_require_host(p_event, p_host_key);
  update party_rounds set status = 'done'
  where event_id = p_event and status <> 'done';
  update party_events set status = 'closed', updated_at = now()
  where id = p_event;
  return jsonb_build_object('ok', true);
end;
$$;

-- The host poll (~2s): the whole picture, host's eyes only.
create or replace function public.party_host_get(p_event uuid, p_host_key text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  e public.party_events%rowtype;
  r public.party_rounds%rowtype;
  v_now bigint := extract(epoch from now())::bigint;
begin
  e := public.bp_require_host(p_event, p_host_key);
  r := public.bp_live_round(p_event);
  return jsonb_build_object(
    'id', e.id, 'code', e.code, 'title', e.title, 'status', e.status,
    'questions', e.questions,
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name,
        'checkinDone', p.checkin <> '{}'::jsonb,
        'away', v_now - p.last_seen > 60
      ) order by p.joined_at)
      from party_players p where p.event_id = e.id), '[]'::jsonb),
    'checkinTallies', public.bp_tallies(e.id),
    'round', case when r.id is null then null else jsonb_build_object(
      'id', r.id, 'mode', r.mode, 'status', r.status, 'config', r.config,
      'revealStep', r.reveal_step, 'results', r.results,
      'submissions', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', s.id, 'name', s.name, 'payload', s.payload, 'status', s.status
        ) order by s.created_at)
        from party_submissions s where s.round_id = r.id), '[]'::jsonb),
      'votes', coalesce((
        select jsonb_agg(jsonb_build_object(
          'playerId', v.player_id, 'target', v.target, 'value', v.value))
        from party_votes v where v.round_id = r.id), '[]'::jsonb)
    ) end,
    'roundsPlayed', (select count(*) from party_rounds
                     where event_id = e.id and status = 'done'),
    'doneResults', public.bp_done_results(e.id, true));
end;
$$;

-- The big-screen poll (~2s) — unauthenticated on purpose (it's a
-- projector), so it may contain ONLY host-authored content (the questions
-- he picked) and host-stored results. Raw submissions never appear here.
create or replace function public.party_screen_get(p_code text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  e public.party_events%rowtype;
  r public.party_rounds%rowtype;
begin
  e := public.bp_event_by_code(p_code);
  r := public.bp_live_round(e.id);
  return jsonb_build_object(
    'code', e.code, 'title', e.title, 'status', e.status,
    'playerCount', (select count(*) from party_players where event_id = e.id),
    'round', case when r.id is null then null else jsonb_build_object(
      'mode', r.mode, 'status', r.status, 'config', r.config,
      'revealStep', r.reveal_step,
      'results', case when r.status = 'revealing' then r.results else null end,
      'submissionCount', (select count(*) from party_submissions
                          where round_id = r.id)
    ) end,
    'doneResults', public.bp_done_results(e.id, false));
end;
$$;

-- ---------------------------------------------------------------- grants
-- Postgres grants EXECUTE to PUBLIC by default and PostgREST exposes every
-- executable public function as an RPC — so lock down ALL the internal
-- helpers. The definer-owned party_* functions can still call them.

revoke all on function
  public.bp_hash(text),
  public.bp_clean_name(text),
  public.bp_check_identity(text),
  public.bp_check_questions(jsonb),
  public.bp_sweep(),
  public.bp_check_budget(),
  public.bp_event_by_code(text),
  public.bp_require_host(uuid, text),
  public.bp_require_player(uuid, text),
  public.bp_live_round(uuid),
  public.bp_tally(uuid, jsonb),
  public.bp_tallies(uuid),
  public.bp_done_results(uuid, boolean)
from public, anon, authenticated;

grant execute on function
  public.party_create_event(text, jsonb, text),
  public.party_join(text, text, text),
  public.party_checkin(uuid, text, jsonb),
  public.party_player_get(uuid, text),
  public.party_submit(uuid, text, uuid, jsonb),
  public.party_vote(uuid, text, uuid, text, int),
  public.party_open_round(uuid, text, text, jsonb),
  public.party_close_round(uuid, text),
  public.party_moderate(uuid, text, uuid, text),
  public.party_moderate_all(uuid, text, uuid, text),
  public.party_start_reveal(uuid, text, uuid, jsonb),
  public.party_reveal_step(uuid, text, uuid, int),
  public.party_end_round(uuid, text),
  public.party_remove_player(uuid, text, uuid),
  public.party_close_event(uuid, text),
  public.party_host_get(uuid, text),
  public.party_screen_get(text)
to anon, authenticated;
