-- Planning Poker · Supabase schema
--
-- Run this whole file once in Supabase → SQL Editor → New query → Run.
-- It is idempotent: running it again is safe.
--
-- Everything is prefixed `pp_` because this project already contains a
-- `public.profiles` table belonging to another application. Nothing here
-- touches it.
--
-- Access model
--   * A session belongs to the account that created it.
--   * Nobody else can see it until they join, and joining requires the
--     session's secret invite token. The token is a capability: holding it is
--     the permission.
--   * Membership is written only by pp_join_room(), so a member row cannot be
--     forged for a session whose token the caller does not have.
--   * Every rule below is enforced by Postgres, not by the browser.

-- ---------------------------------------------------------------- tables ----

create table if not exists public.pp_profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text        not null default 'Guest',
  is_anonymous boolean     not null default true,
  created_at   timestamptz not null default now()
);

create table if not exists public.pp_rooms (
  id           text        primary key,
  owner_id     uuid        not null references auth.users (id) on delete cascade,
  name         text        not null default 'Refinement',
  invite_token text        not null unique default replace(gen_random_uuid()::text, '-', ''),
  state        jsonb       not null default '{}'::jsonb,
  version      bigint      not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists pp_rooms_owner_idx on public.pp_rooms (owner_id, updated_at desc);

create table if not exists public.pp_room_members (
  room_id      text        not null references public.pp_rooms (id) on delete cascade,
  user_id      uuid        not null references auth.users (id) on delete cascade,
  display_name text        not null default 'Guest',
  role         text        not null default 'voter' check (role in ('voter', 'spectator')),
  joined_at    timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  primary key (room_id, user_id)
);

create index if not exists pp_room_members_user_idx on public.pp_room_members (user_id);

-- One row per account: the Jira connection that account uses. Kept server side
-- so the credentials follow the person between browsers and machines instead of
-- living in localStorage. Row level security below means an account can read
-- and write its own row and no other.
create table if not exists public.pp_jira_settings (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  base_url     text        not null default '',
  email        text        not null default '',
  token        text        not null default '',
  points_field text        not null default 'customfield_10033',
  proxy        text        not null default '',
  mock         boolean     not null default false,
  updated_at   timestamptz not null default now()
);

-- ------------------------------------------------------------- helpers ------
-- SECURITY DEFINER so the policies below can ask "is this person a member?"
-- without re-entering the policy that asked. Without this, pp_rooms →
-- pp_room_members → pp_rooms recurses and Postgres refuses the query.

create or replace function public.pp_is_member(p_room_id text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.pp_room_members m
    where m.room_id = p_room_id and m.user_id = auth.uid()
  );
$$;

create or replace function public.pp_is_owner(p_room_id text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.pp_rooms r
    where r.id = p_room_id and r.owner_id = auth.uid()
  );
$$;

-- --------------------------------------------------------------- RLS --------

alter table public.pp_profiles      enable row level security;
alter table public.pp_rooms         enable row level security;
alter table public.pp_room_members  enable row level security;
alter table public.pp_jira_settings enable row level security;

-- Jira credentials: yours and nobody else's, in either direction.
drop policy if exists pp_jira_select on public.pp_jira_settings;
create policy pp_jira_select on public.pp_jira_settings for select
  using (user_id = auth.uid());

drop policy if exists pp_jira_insert on public.pp_jira_settings;
create policy pp_jira_insert on public.pp_jira_settings for insert
  with check (user_id = auth.uid());

drop policy if exists pp_jira_update on public.pp_jira_settings;
create policy pp_jira_update on public.pp_jira_settings for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists pp_jira_delete on public.pp_jira_settings;
create policy pp_jira_delete on public.pp_jira_settings for delete
  using (user_id = auth.uid());

-- profiles: your own row, plus the rows of people you share a session with.
drop policy if exists pp_profiles_select on public.pp_profiles;
create policy pp_profiles_select on public.pp_profiles for select
  using (
    id = auth.uid()
    or exists (
      select 1
      from public.pp_room_members mine
      join public.pp_room_members theirs on theirs.room_id = mine.room_id
      where mine.user_id = auth.uid() and theirs.user_id = pp_profiles.id
    )
  );

drop policy if exists pp_profiles_insert on public.pp_profiles;
create policy pp_profiles_insert on public.pp_profiles for insert
  with check (id = auth.uid());

drop policy if exists pp_profiles_update on public.pp_profiles;
create policy pp_profiles_update on public.pp_profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

-- sessions: owners always; members while they are members. Nobody else.
drop policy if exists pp_rooms_select on public.pp_rooms;
create policy pp_rooms_select on public.pp_rooms for select
  using (owner_id = auth.uid() or public.pp_is_member(id));

drop policy if exists pp_rooms_insert on public.pp_rooms;
create policy pp_rooms_insert on public.pp_rooms for insert
  with check (owner_id = auth.uid());

-- Members may write session state — that is how votes and stories are saved.
-- owner_id, id and invite_token are frozen by the trigger further down.
drop policy if exists pp_rooms_update on public.pp_rooms;
create policy pp_rooms_update on public.pp_rooms for update
  using (owner_id = auth.uid() or public.pp_is_member(id))
  with check (owner_id = auth.uid() or public.pp_is_member(id));

drop policy if exists pp_rooms_delete on public.pp_rooms;
create policy pp_rooms_delete on public.pp_rooms for delete
  using (owner_id = auth.uid());

-- membership: everyone in a session sees who else is in it.
drop policy if exists pp_members_select on public.pp_room_members;
create policy pp_members_select on public.pp_room_members for select
  using (user_id = auth.uid() or public.pp_is_member(room_id) or public.pp_is_owner(room_id));

-- Direct inserts are for the session owner only. Everyone else goes through
-- pp_join_room(), which demands the invite token.
drop policy if exists pp_members_insert on public.pp_room_members;
create policy pp_members_insert on public.pp_room_members for insert
  with check (user_id = auth.uid() and public.pp_is_owner(room_id));

drop policy if exists pp_members_update on public.pp_room_members;
create policy pp_members_update on public.pp_room_members for update
  using (user_id = auth.uid() or public.pp_is_owner(room_id))
  with check (user_id = auth.uid() or public.pp_is_owner(room_id));

-- Leave a session yourself, or be removed by the host.
drop policy if exists pp_members_delete on public.pp_room_members;
create policy pp_members_delete on public.pp_room_members for delete
  using (user_id = auth.uid() or public.pp_is_owner(room_id));

-- ------------------------------------------------------------ triggers ------

create or replace function public.pp_touch_room()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  -- Ownership, id and the invite token are not the caller's to change.
  new.owner_id     := old.owner_id;
  new.invite_token := old.invite_token;
  new.id           := old.id;
  return new;
end;
$$;

drop trigger if exists pp_rooms_touch on public.pp_rooms;
create trigger pp_rooms_touch before update on public.pp_rooms
  for each row execute function public.pp_touch_room();

-- A profile row for every new account, anonymous ones included.
create or replace function public.pp_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.pp_profiles (id, display_name, is_anonymous)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), 'Guest'),
    new.email is null
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists pp_on_auth_user_created on auth.users;
create trigger pp_on_auth_user_created after insert on auth.users
  for each row execute function public.pp_handle_new_user();

-- ------------------------------------------------------- invite functions ---

-- What an invited person may see *before* joining: enough to recognise the
-- session, nothing about its contents.
create or replace function public.pp_room_preview(p_invite_token text)
returns table (room_id text, room_name text, host_name text, member_count bigint)
language sql
security definer
stable
set search_path = public
as $$
  select r.id,
         r.name,
         coalesce(p.display_name, 'Host'),
         (select count(*) from public.pp_room_members m where m.room_id = r.id)
  from public.pp_rooms r
  left join public.pp_profiles p on p.id = r.owner_id
  where r.invite_token = p_invite_token;
$$;

-- Redeem an invite. Holding the token is the permission, so the row is written
-- under the definer's rights and no direct INSERT policy has to be opened up.
create or replace function public.pp_join_room(
  p_invite_token text,
  p_display_name text default 'Guest',
  p_role         text default 'voter'
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id text;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;

  select id into v_room_id from public.pp_rooms where invite_token = p_invite_token;
  if v_room_id is null then
    raise exception 'invite not found';
  end if;

  insert into public.pp_room_members (room_id, user_id, display_name, role)
  values (v_room_id, auth.uid(), coalesce(nullif(p_display_name, ''), 'Guest'),
          case when p_role = 'spectator' then 'spectator' else 'voter' end)
  on conflict (room_id, user_id) do update
    set display_name = excluded.display_name,
        role         = excluded.role,
        last_seen    = now();

  insert into public.pp_profiles (id, display_name, is_anonymous)
  values (auth.uid(), coalesce(nullif(p_display_name, ''), 'Guest'), true)
  on conflict (id) do update
    set display_name = coalesce(nullif(excluded.display_name, ''), pp_profiles.display_name);

  return v_room_id;
end;
$$;

revoke all on function public.pp_room_preview(text) from public;
revoke all on function public.pp_join_room(text, text, text) from public;
grant execute on function public.pp_room_preview(text) to anon, authenticated;
grant execute on function public.pp_join_room(text, text, text) to authenticated;

-- ----------------------------------------------------------- realtime -------

alter table public.pp_rooms replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.pp_rooms;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;

do $$
begin
  alter publication supabase_realtime add table public.pp_room_members;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;
