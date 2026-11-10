// VOOB CORE — пароль для входа (Supabase Edge Function voob-core-pwd)
// Пароль — альтернативный первый шаг вместо QR: после него всё равно нужен код с почты (voob-core, mail_verify).
// Добавление, смена и удаление пароля подтверждаются 6-значным PIN, который приходит на почту для кодов.
// Таблицы: core_config(pwd_hash, pwd_salt, pwd_updated_at, email), core_otp, core_attempts, sessions, admin_log.
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const BOT = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const ADMIN = Number(Deno.env.get("ADMIN_TG_ID") ?? 0) || 702410323;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const MAIL_FROM = Deno.env.get("CORE_MAIL_FROM") ?? "VOOB CORE <onboarding@resend.dev>";
const ORIGINS = ["https://core.voob.kz"];
function serverKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"); if (legacy) return legacy;
  const single = Deno.env.get("SUPABASE_SECRET_KEY"); if (single) return single;
  try { const all = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); return all.default ?? Object.values(all)[0] ?? ""; } catch { return ""; }
}
const db = createClient(SB_URL, serverKey(), { auth: { persistSession: false } });
const corsFor = (req: Request) => {
  const o = req.headers.get("origin") ?? "";
  return { "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0], "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Cache-Control": "no-store" };
};
const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const DAY = 86400000;
const CORE_IDLE = 30 * 60000, CORE_MAX = 8 * 3600000;
const MAIL_TTL = 10 * 60000, MAIL_TRIES = 3, MAIL_COOLDOWN = 30000;
const LOCK_FAILS = 6, LOCK_WINDOW = 15 * 60000;
const PBKDF_ITER = 210000, PWD_MIN = 10, PWD_MAX = 128;

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const randToken = () => { const b = crypto.getRandomValues(new Uint8Array(32)); return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const randCode = (n: number) => String(crypto.getRandomValues(new Uint32Array(1))[0] % 10 ** n).padStart(n, "0");
const maskMail = (e: string) => { const [u, d] = String(e).split("@"); return (u?.[0] ?? "") + "•••@" + (d ?? ""); };
async function tg(text: string) {
  try { await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: ADMIN, text }) }); } catch { /* ignore */ }
}
async function log(action: string, details: unknown = null) { await db.from("admin_log").insert({ action, target: null, details }); }
function mailHtml(lead: string, big: string, foot: string) {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0b0b0d;color:#e9e9ee;padding:32px;border-radius:16px;max-width:440px">`
    + `<div style="letter-spacing:.3em;font-weight:300;font-size:13px;color:#8b8b96">VOOB CORE</div>`
    + `<p style="font-size:15px;margin:18px 0 8px;line-height:1.5">${lead}</p>`
    + (big ? `<div style="font-size:34px;letter-spacing:.35em;font-weight:600;margin:8px 0 18px">${big}</div>` : "")
    + `<p style="font-size:12px;color:#8b8b96;line-height:1.5;margin:0">${foot}</p></div>`;
}
async function sendMail(to: string, subject: string, html: string) {
  if (!RESEND_KEY) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html }) });
    return r.ok;
  } catch { return false; }
}
async function cfg() { const { data } = await db.from("core_config").select("*").eq("id", 1).maybeSingle(); return data as any; }
async function locked() {
  const { count } = await db.from("core_attempts").select("id", { count: "exact", head: true }).eq("ok", false).gte("at", new Date(Date.now() - LOCK_WINDOW).toISOString());
  return (count ?? 0) >= LOCK_FAILS;
}
async function derive(pwd: string, saltHex: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pwd), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g)!.map((h) => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF_ITER }, key, 256));
}

// ---- вход по паролю: создаёт ту же WEB-сессию, что и QR; дальше нужен код с почты
async function pwdLogin(body: any) {
  if (await locked()) return { status: "locked" };
  const pwd = String(body?.password ?? "");
  const c = await cfg();
  if (!c?.pwd_hash || !c?.pwd_salt) { await derive("x", "00".repeat(16)); return { status: "nopwd" }; }
  const ok = pwd.length >= 1 && pwd.length <= PWD_MAX && safeEqual(await derive(pwd, c.pwd_salt), c.pwd_hash);
  if (!ok) {
    await db.from("core_attempts").insert({ kind: "pwd", ok: false });
    return { status: "wrong" };
  }
  const token = randToken();
  const { error } = await db.from("sessions").insert({ token_hash: await sha256(token), tg_id: ADMIN, device: "core" });
  if (error) return { error: "Не удалось создать сессию" };
  await log("core_pwd_login", {});
  return { status: "ok", token };
}
async function pwdPublicStatus() { const c = await cfg(); return { status: "ok", has_pwd: !!c?.pwd_hash }; }

// ---- PIN на почту
async function issue(th: string, kind: string) {
  const code = randCode(6);
  const { error } = await db.from("core_otp").insert({ th, purpose: "pwd", payload: kind, code_hash: await sha256(`coremail:pwd:${th}:${code}`) });
  return error ? null : code;
}
async function pinStart(th: string, kind: string) {
  if (kind !== "set" && kind !== "remove") return { error: "Неверное действие" };
  if (await locked()) return { status: "locked" };
  const { data: last } = await db.from("core_otp").select("created_at").eq("th", th).eq("purpose", "pwd").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (last && Date.now() - Date.parse(last.created_at) < MAIL_COOLDOWN) return { status: "soon" };
  const c = await cfg();
  if (!c?.email) return { status: "error", error: "Почта не настроена" };
  if (kind === "remove" && !c.pwd_hash) return { error: "Пароль не задан" };
  const code = await issue(th, kind);
  if (!code) return { status: "error", error: "Не удалось создать код" };
  const lead = kind === "remove" ? "PIN для <b>удаления пароля</b> VOOB CORE:" : c.pwd_hash ? "PIN для <b>смены пароля</b> VOOB CORE:" : "PIN для <b>добавления пароля</b> VOOB CORE:";
  const ok = await sendMail(c.email, `VOOB CORE · PIN ${code}`, mailHtml(lead, code, "PIN действует 10 минут и работает один раз. Если это не ты, никому его не называй и проверь журнал в VOOB CORE."));
  return { status: ok ? "sent" : "undelivered", to: maskMail(c.email) };
}
async function pinCheck(th: string, kind: string, codeIn: unknown) {
  if (await locked()) return { status: "locked" } as any;
  const code = String(codeIn ?? "").replace(/\D/g, "");
  const { data: r } = await db.from("core_otp").select("id, code_hash, tries, created_at, payload").eq("th", th).eq("purpose", "pwd").is("used_at", null)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!r || Date.now() - Date.parse(r.created_at) > MAIL_TTL || r.payload !== kind) return { status: "expired" } as any;
  if (r.tries >= MAIL_TRIES) return { status: "spent" } as any;
  if (code.length !== 6 || !safeEqual(await sha256(`coremail:pwd:${th}:${code}`), r.code_hash)) {
    await db.from("core_otp").update({ tries: r.tries + 1 }).eq("id", r.id);
    await db.from("core_attempts").insert({ kind: "pwd_pin", ok: false });
    return { status: r.tries + 1 >= MAIL_TRIES ? "spent" : "wrong", left: MAIL_TRIES - r.tries - 1 } as any;
  }
  await db.from("core_otp").update({ used_at: new Date().toISOString() }).eq("id", r.id).is("used_at", null);
  return { status: "ok" } as any;
}
async function pwdSet(th: string, body: any) {
  const pwd = String(body?.password ?? "");
  if (pwd.length < PWD_MIN) return { error: `Пароль слишком короткий: минимум ${PWD_MIN} символов` };
  if (pwd.length > PWD_MAX) return { error: `Пароль слишком длинный: максимум ${PWD_MAX} символов` };
  const r = await pinCheck(th, "set", body?.code);
  if (r.status !== "ok") return r;
  const c = await cfg();
  const had = !!c?.pwd_hash;
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  await db.from("core_config").update({ pwd_hash: await derive(pwd, salt), pwd_salt: salt, pwd_updated_at: new Date().toISOString() }).eq("id", 1);
  await log(had ? "core_pwd_change" : "core_pwd_add", {});
  await tg(had ? "🔑 Пароль VOOB CORE изменён." : "🔑 Для VOOB CORE добавлен пароль. Теперь можно входить по паролю (код с почты по-прежнему нужен).");
  return { status: "ok", has_pwd: true };
}
async function pwdRemove(th: string, body: any) {
  const r = await pinCheck(th, "remove", body?.code);
  if (r.status !== "ok") return r;
  await db.from("core_config").update({ pwd_hash: null, pwd_salt: null, pwd_updated_at: null }).eq("id", 1);
  await log("core_pwd_remove", {});
  await tg("🔑 Пароль VOOB CORE удалён. Вход — через QR Telegram и код с почты.");
  return { status: "ok", has_pwd: false };
}

Deno.serve(async (req) => {
  const CORS = corsFor(req);
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ app: "VOOB CORE pwd", ok: true });
  try {
    const body = await req.json().catch(() => ({}));
    const a = String(body?.action ?? "");
    if (a === "pwd_login") return json(await pwdLogin(body));
    if (a === "pwd_public") return json(await pwdPublicStatus());
    const tok = body?.token;
    if (typeof tok !== "string" || tok.length < 20) return json({ error: "Нет сессии" }, 401);
    const th = await sha256(tok);
    const { data: s } = await db.from("sessions").select("tg_id, device, created_at, last_seen").eq("token_hash", th).maybeSingle();
    if (!s || Number(s.tg_id) !== ADMIN || s.device !== "core") return json({ error: "Сессия недействительна — войди заново" }, 401);
    const born = Date.parse(s.created_at), seen = Date.parse(s.last_seen ?? s.created_at) || born;
    if (Date.now() - born > CORE_MAX || Date.now() - seen > CORE_IDLE) return json({ error: "Сессия истекла — войди заново", expired: true }, 401);
    // как и везде в Core: пока вход не подтверждён кодом с почты, действий нет
    const { data: v } = await db.from("core_otp").select("id").eq("th", th).eq("purpose", "login").not("used_at", "is", null).limit(1);
    if (!v?.length) return json({ error: "Подтверди вход кодом с почты", need_otp: true }, 401);
    await db.from("sessions").update({ last_seen: new Date().toISOString() }).eq("token_hash", th);
    const c = await cfg();
    switch (a) {
      case "pwd_status": return json({ status: "ok", has_pwd: !!c?.pwd_hash, updated: c?.pwd_updated_at ?? null });
      case "pwd_start": return json(await pinStart(th, String(body?.kind ?? "")));
      case "pwd_set": return json(await pwdSet(th, body));
      case "pwd_remove": return json(await pwdRemove(th, body));
    }
    return json({ error: "Неизвестное действие" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "Внутренняя ошибка сервера" }, 500);
  }
});
