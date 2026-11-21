-- Сохранённые сегменты аудитории для рассылки (Core): название и правило {inc:[...], exc:[...]}
create table if not exists public.core_segments (
  id bigserial primary key,
  name text not null,
  rule jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.core_segments enable row level security;
grant select, insert, update, delete on public.core_segments to service_role;
grant usage, select on sequence public.core_segments_id_seq to service_role;
