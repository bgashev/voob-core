// VOOB: уведомление создателю о новом пользователе. Вызывается триггером базы (после вставки в users).
// Защита без секрета: функция сама проверяет, что человек реально есть в базе, зарегистрирован менее 10 минут назад и ещё не был объявлен.
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const BOT = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const ADMIN = Number(Deno.env.get("ADMIN_TG_ID") ?? 0) || 702410323;
function serverKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const single = Deno.env.get("SUPABASE_SECRET_KEY");
  if (single) return single;
  try { const all = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); return all.default ?? Object.values(all)[0] ?? ""; } catch { return ""; }
}
const db = createClient(SB_URL, serverKey(), { auth: { persistSession: false } });
const h = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
const ok = () => new Response("ok");

Deno.serve(async (req) => {
  if (req.method !== "POST") return ok();
  try {
    const b = await req.json().catch(() => ({}));
    const id = Number(b?.tg_id);
    if (!id || id === ADMIN) return ok();
    const { data: u } = await db.from("users").select("tg_id, first_name, username, handle, created_at").eq("tg_id", id).maybeSingle();
    if (!u || Date.now() - Date.parse(u.created_at) > 10 * 60000) return ok();
    const { data: seen } = await db.from("admin_log").select("id").eq("action", "new_user").eq("target", id).limit(1);
    if (seen?.length) return ok();
    await db.from("admin_log").insert({ action: "new_user", target: id, details: {} });
    const { count } = await db.from("users").select("tg_id", { count: "exact", head: true });
    const who = h(u.first_name || u.username || id) + (u.username ? ` (@${h(u.username)})` : "");
    const text = `🆕 <b>Новый пользователь VOOB</b>\n\n${who}\nID: <code>${id}</code>\nВсего людей: <b>${count ?? "?"}</b>`;
    // беззвучно: приходит без звука и вибрации, только значок
    await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: ADMIN, parse_mode: "HTML", disable_notification: true, text, reply_markup: { inline_keyboard: [[{ text: "Открыть в Core", url: `https://core.voob.kz/users/${id}` }]] } }) });
  } catch (e) { console.error(e); }
  return ok();
});
