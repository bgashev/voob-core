create table if not exists public.user_notes (
  tg_id bigint primary key references public.users(tg_id) on delete cascade,
  note text not null default '' check (char_length(note) <= 600),
  tags text[] not null default '{}',
  updated_at timestamptz not null default now()
);
alter table public.user_notes enable row level security;
grant select, insert, update, delete on public.user_notes to service_role;
