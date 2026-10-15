insert into public.profiles (id, name, role)
select
  id,
  coalesce(raw_user_meta_data->>'name', 'Użytkownik'),
  case when raw_user_meta_data->>'role' = 'teacher' then 'teacher' else 'student' end
from auth.users
on conflict (id) do nothing;

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

revoke all on function public.is_board_owner(text) from public, anon;
revoke all on function public.is_board_member(text) from public, anon;
grant execute on function public.is_board_owner(text) to authenticated;
grant execute on function public.is_board_member(text) to authenticated;

drop policy if exists "read member boards" on public.boards;
create policy "read member boards" on public.boards
  for select using (owner_id = auth.uid() or public.is_board_member(id));

drop policy if exists "read memberships" on public.board_members;
create policy "read memberships" on public.board_members
  for select using (user_id = auth.uid() or public.is_board_owner(board_id));

drop policy if exists "join or invite" on public.board_members;
create policy "join or invite" on public.board_members
  for insert with check (user_id = auth.uid() or public.is_board_owner(board_id));

drop policy if exists "owner removes members" on public.board_members;
create policy "owner removes members" on public.board_members
  for delete using (public.is_board_owner(board_id));

drop policy if exists "owner reads secret" on public.board_secrets;
create policy "owner reads secret" on public.board_secrets
  for select using (public.is_board_owner(board_id));

drop policy if exists "owner writes secret" on public.board_secrets;
create policy "owner writes secret" on public.board_secrets
  for insert with check (public.is_board_owner(board_id));

drop policy if exists "owner updates secret" on public.board_secrets;
create policy "owner updates secret" on public.board_secrets
  for update using (public.is_board_owner(board_id));

drop policy if exists "owner deletes secret" on public.board_secrets;
create policy "owner deletes secret" on public.board_secrets
  for delete using (public.is_board_owner(board_id));

drop policy if exists "members read snapshots" on public.board_snapshots;
create policy "members read snapshots" on public.board_snapshots
  for select using (public.is_board_owner(board_id) or public.is_board_member(board_id));

drop policy if exists "members insert snapshots" on public.board_snapshots;
create policy "members insert snapshots" on public.board_snapshots
  for insert with check (public.is_board_owner(board_id) or public.is_board_member(board_id));

drop policy if exists "members update snapshots" on public.board_snapshots;
create policy "members update snapshots" on public.board_snapshots
  for update using (public.is_board_owner(board_id) or public.is_board_member(board_id));

drop policy if exists "owner deletes snapshots" on public.board_snapshots;
create policy "owner deletes snapshots" on public.board_snapshots
  for delete using (public.is_board_owner(board_id));
