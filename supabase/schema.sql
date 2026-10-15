create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null,
  role text not null check (role in ('teacher', 'student')),
  created_at timestamptz not null default now()
);

create table if not exists public.boards (
  id text primary key,
  title text not null,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  booking_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.board_members (
  board_id text not null references public.boards (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('teacher', 'student')),
  access text not null default 'observer' check (access in ('editor', 'observer')),
  primary key (board_id, user_id)
);

create table if not exists public.board_secrets (
  board_id text primary key references public.boards (id) on delete cascade,
  teacher_key text not null
);

create table if not exists public.board_snapshots (
  board_id text primary key references public.boards (id) on delete cascade,
  snapshot text not null,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.boards enable row level security;
alter table public.board_members enable row level security;
alter table public.board_secrets enable row level security;
alter table public.board_snapshots enable row level security;

create or replace function public.is_board_owner(target_board text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.boards
    where id = target_board and owner_id = auth.uid()
  );
$$;

create or replace function public.is_board_member(target_board text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.board_members
    where board_id = target_board and user_id = auth.uid()
  );
$$;

create or replace function public.is_board_editor(target_board text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.boards
    where id = target_board and owner_id = auth.uid()
  )
  or exists (
    select 1 from public.board_members
    where board_id = target_board and user_id = auth.uid() and access = 'editor'
  );
$$;

revoke all on function public.is_board_owner(text) from public, anon;
revoke all on function public.is_board_member(text) from public, anon;
revoke all on function public.is_board_editor(text) from public, anon;
grant execute on function public.is_board_owner(text) to authenticated;
grant execute on function public.is_board_member(text) to authenticated;
grant execute on function public.is_board_editor(text) to authenticated;

create or replace function public.my_board_people()
returns table (board_id text, name text, access text)
language sql
stable
security definer
set search_path = public
as $$
  with mine as (
    select id as board_id from public.boards where owner_id = auth.uid()
    union
    select board_members.board_id from public.board_members where user_id = auth.uid()
  )
  select members.board_id, profiles.name, members.access
  from public.board_members as members
  join public.profiles on profiles.id = members.user_id
  join mine on mine.board_id = members.board_id
  union
  select boards.id, profiles.name, 'editor'
  from public.boards
  join public.profiles on profiles.id = boards.owner_id
  join mine on mine.board_id = boards.id
  where not exists (
    select 1 from public.board_members
    where board_members.board_id = boards.id and board_members.user_id = boards.owner_id
  );
$$;

revoke all on function public.my_board_people() from public, anon;
grant execute on function public.my_board_people() to authenticated;

create policy "read own profile" on public.profiles
  for select using (auth.uid() = id);
create policy "insert own profile" on public.profiles
  for insert with check (auth.uid() = id);
create policy "update own profile" on public.profiles
  for update using (auth.uid() = id);

create policy "read member boards" on public.boards
  for select using (owner_id = auth.uid() or public.is_board_member(id));
create policy "teacher creates boards" on public.boards
  for insert with check (owner_id = auth.uid());
create policy "owner updates boards" on public.boards
  for update using (owner_id = auth.uid());
create policy "owner deletes boards" on public.boards
  for delete using (owner_id = auth.uid());

create policy "read memberships" on public.board_members
  for select using (user_id = auth.uid() or public.is_board_editor(board_id));
create policy "join or invite" on public.board_members
  for insert with check (
    public.is_board_editor(board_id)
    or (user_id = auth.uid() and access = 'observer')
  );
create policy "editors set access" on public.board_members
  for update using (public.is_board_editor(board_id))
  with check (public.is_board_editor(board_id));
create policy "owner removes members" on public.board_members
  for delete using (public.is_board_owner(board_id));
create policy "leave board" on public.board_members
  for delete using (user_id = auth.uid());

create policy "owner reads secret" on public.board_secrets
  for select using (public.is_board_owner(board_id));
create policy "owner writes secret" on public.board_secrets
  for insert with check (public.is_board_owner(board_id));
create policy "owner updates secret" on public.board_secrets
  for update using (public.is_board_owner(board_id));
create policy "owner deletes secret" on public.board_secrets
  for delete using (public.is_board_owner(board_id));

create policy "members read snapshots" on public.board_snapshots
  for select using (public.is_board_owner(board_id) or public.is_board_member(board_id));
create policy "members insert snapshots" on public.board_snapshots
  for insert with check (public.is_board_editor(board_id));
create policy "members update snapshots" on public.board_snapshots
  for update using (public.is_board_editor(board_id));
create policy "owner deletes snapshots" on public.board_snapshots
  for delete using (public.is_board_owner(board_id));

insert into storage.buckets (id, name, public)
values ('board-assets', 'board-assets', false)
on conflict (id) do nothing;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', 'Użytkownik'),
    case when new.raw_user_meta_data->>'role' = 'teacher' then 'teacher' else 'student' end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
