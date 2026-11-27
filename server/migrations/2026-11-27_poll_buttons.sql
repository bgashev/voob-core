-- Опрос с кнопками (2–4 варианта) + починка: база не принимала kind='poll', action='answer' и feedback type='poll'
alter table public.announcements add column if not exists options jsonb;
alter table public.announcements add column if not exists show_results boolean not null default false;
alter table public.announcements drop constraint if exists announcements_kind_check;
alter table public.announcements add constraint announcements_kind_check check (kind in ('gift','notice','promo','poll'));
alter table public.announce_inbox add column if not exists choice smallint check (choice between 0 and 3);
alter table public.announce_inbox drop constraint if exists announce_inbox_action_check;
alter table public.announce_inbox add constraint announce_inbox_action_check check (action in ('click','dismiss','ack','answer'));
alter table public.feedback drop constraint if exists feedback_type_check;
alter table public.feedback add constraint feedback_type_check check (type in ('idea','bug','complaint','user','poll'));
