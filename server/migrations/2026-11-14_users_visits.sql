-- Счётчик заходов: заход = возвращение после 30+ минут без активности. Считается с момента создания (у всех стартовое значение 1).
alter table public.users add column if not exists visits integer not null default 1;
create or replace function public.count_visit() returns trigger language plpgsql as $$
begin
  if NEW.last_seen is not null and OLD.last_seen is not null and NEW.last_seen - OLD.last_seen > interval '30 minutes' then
    NEW.visits := coalesce(OLD.visits, 1) + 1;
  end if;
  return NEW;
end $$;
drop trigger if exists trg_count_visit on public.users;
create trigger trg_count_visit before update of last_seen on public.users for each row execute function public.count_visit();
