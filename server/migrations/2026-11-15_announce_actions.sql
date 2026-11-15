-- что человек сделал с объявлением: нажал кнопку / скрыл / «понятно»
alter table public.announce_inbox add column if not exists action text check (action in ('click','dismiss','ack'));
alter table public.announce_inbox add column if not exists acted_at timestamptz;
