-- Safe to run more than once in Supabase: SQL Editor > paste > Run.
create table if not exists public.shelf_data (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.shelf_data enable row level security;
drop policy if exists "own row only" on public.shelf_data;
create policy "own row only" on public.shelf_data
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- The Data API also needs table privileges; RLS still restricts rows to their owner.
grant select, insert, update on public.shelf_data to authenticated;
