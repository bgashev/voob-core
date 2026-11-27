-- Удаление аккаунта из VOOB CORE: всё, что стирает delete_account, плюс таблицы без каскада.
-- Платежи (pro_payments, shop_owned, refund_requests) и журнал админа остаются: это финансовый учёт и след действия.
create or replace function public.core_delete_account(p_tg bigint)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if p_tg = 702410323 then raise exception 'creator account cannot be deleted'; end if;
  perform 1 from users where tg_id = p_tg for update;
  if not found then return false; end if;
  delete from game_scores where tg_id = p_tg;
  delete from net_invites where from_id = p_tg or to_id = p_tg;
  delete from net_rooms where host_id = p_tg or guest_id = p_tg;
  delete from net_presence where tg_id = p_tg;
  delete from habit_duels where from_id = p_tg or to_id = p_tg;
  delete from habit_reminders where tg_id = p_tg;
  delete from google_links where tg_id = p_tg;
  delete from user_passwords where tg_id = p_tg;
  perform delete_account(p_tg);
  return true;
end $$;
revoke all on function public.core_delete_account(bigint) from public, anon, authenticated;
grant execute on function public.core_delete_account(bigint) to service_role;
