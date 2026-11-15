-- Отложенная отправка рассылок и объявлений (Core)
create table if not exists public.scheduled_sends (
  id bigserial primary key,
  fn text not null check (fn in ('broadcast','announce')),
  payload jsonb not null,
  run_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','running','sent','failed','cancelled')),
  summary text,
  result jsonb,
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index if not exists scheduled_sends_due on public.scheduled_sends(status, run_at);
alter table public.scheduled_sends enable row level security;
grant select, insert, update, delete on public.scheduled_sends to service_role;
grant usage, select on sequence public.scheduled_sends_id_seq to service_role;
