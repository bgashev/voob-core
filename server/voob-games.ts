// VOOB «games» — статистика игр пользователя для VOOB CORE (только чтение, только создатель).
// Проверка входа такая же, как в voob-extra: сессия + (для WEB Core) срок жизни и подтверждённый вход по почте, для Windows — код из Telegram.
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ADMIN = Number(Deno.env.get("ADMIN_TG_ID") ?? 0) || 702410323;
function serverKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const single = Deno.env.get("SUPABASE_SECRET_KEY");
  if (single) return single;
  try { const all = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); return all.default ?? Object.values(all)[0] ?? ""; } catch { return ""; }
}
const db = createClient(SB_URL, serverKey(), { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
const enc = new TextEncoder();
const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))].map((x) => x.toString(16).padStart(2, "0")).join("");
const DAY = 86400000;

async function verified(th: string) {
  const { data } = await db.from("admin_log").select("id").eq("action", "login").eq("details->>th", th)
    .gte("at", new Date(Date.now() - 30 * DAY).toISOString()).limit(1);
  return !!data?.length;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ app: "VOOB games", ok: true });
  try {
    const body = await req.json().catch(() => ({}));
    const tok = body?.token;
    if (typeof tok !== "string" || tok.length < 20) return json({ error: "Нет сессии" }, 401);
    const th = await sha256(tok);
    const { data: s } = await db.from("sessions").select("tg_id, device, created_at, last_seen").eq("token_hash", th).maybeSingle();
    if (!s) return json({ error: "Сессия недействительна — войди заново" }, 401);
    if (Number(s.tg_id) !== ADMIN) return json({ error: "Доступ только для создателя VOOB" }, 403);
    if ((s as any).device === "core") {
      const born = Date.parse((s as any).created_at), seenAt = Date.parse((s as any).last_seen ?? (s as any).created_at) || born;
      if (Date.now() - born > 8 * 3600000 || Date.now() - seenAt > 30 * 60000) return json({ error: "Сессия истекла — войди заново", expired: true }, 401);
      const { data: okLogin } = await db.from("core_otp").select("id").eq("th", th).eq("purpose", "login").not("used_at", "is", null).limit(1);
      if (!okLogin?.length) return json({ error: "Подтверди вход кодом с почты", need_otp: true }, 401);
    } else if (!(await verified(th))) return json({ error: "Подтверди вход кодом из Telegram", need_otp: true }, 401);
    if (String(body?.action ?? "") !== "user_games") return json({ error: "Неизвестное действие" }, 400);
    const id = Number(body?.tg_id ?? 0);
    if (!(id > 0)) return json({ error: "Нет пользователя" }, 400);
    const { data } = await db.from("game_scores").select("game, best, plays, last_played, updated").eq("tg_id", id).limit(40);
    return json({ games: (data ?? []).map((r: any) => ({ game: r.game, best: r.best ?? 0, plays: r.plays ?? 0, last: r.last_played ?? r.updated ?? null })) });
  } catch (e) {
    console.error(e);
    return json({ error: "Внутренняя ошибка сервера" }, 500);
  }
});
