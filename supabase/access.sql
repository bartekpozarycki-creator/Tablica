alter table public.board_members
  add column if not exists access text;

update public.board_members
set access = case when role = 'teacher' then 'editor' else 'observer' end
where access is null or access not in ('editor', 'observer');

alter table public.board_members
  alter column access set default 'observer';

alter table public.board_members
  alter column access set not null;

alter table public.board_members
  drop constraint if exists board_members_access_check;

alter table public.board_members
  add constraint board_members_access_check check (access in ('editor', 'observer'));

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

revoke all on function public.is_board_editor(text) from public, anon;
grant execute on function public.is_board_editor(text) to authenticated;

drop policy if exists "read memberships" on public.board_members;
create policy "read memberships" on public.board_members
  for select using (user_id = auth.uid() or public.is_board_editor(board_id));

drop policy if exists "join or invite" on public.board_members;
create policy "join or invite" on public.board_members
  for insert with check (
    public.is_board_editor(board_id)
    or (user_id = auth.uid() and access = 'observer')
  );

drop policy if exists "editors set access" on public.board_members;
create policy "editors set access" on public.board_members
  for update using (public.is_board_editor(board_id))
  with check (public.is_board_editor(board_id));

drop policy if exists "members insert snapshots" on public.board_snapshots;
create policy "members insert snapshots" on public.board_snapshots
  for insert with check (public.is_board_editor(board_id));

drop policy if exists "members update snapshots" on public.board_snapshots;
create policy "members update snapshots" on public.board_snapshots
  for update using (public.is_board_editor(board_id));

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
