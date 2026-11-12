-- Run once in Supabase: SQL Editor > New query > paste > Run
create table shelf_data (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table shelf_data enable row level security;
create policy "own row only" on shelf_data for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- The Data API also needs table privileges; RLS still restricts rows to their owner.
grant select, insert, update on public.shelf_data to authenticated;
