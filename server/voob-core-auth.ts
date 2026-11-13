// VOOB CORE — вход «любые 2 из 3» (Supabase Edge Function voob-core-auth)
// Способы: tg (QR/бот), pwd (почта + пароль), mail (6-значный код на почту), backup (резервный код, заменяет любой один способ).
// Один и тот же способ дважды не засчитывается. Сессия создаётся только когда пройдено 2 разных способа:
// пока их меньше, в таблице sessions нет ни строки, поэтому ни одно действие Core недоступно.
// Таблицы: core_flow, core_backup, core_config, core_otp, core_attempts, login_codes, sessions, admin_log.
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
const MAIL_TTL = 10 * 60000, MAIL_TRIES = 3, MAIL_COOLDOWN = 30000, STEP_FRESH = 5 * 60000;
const FLOW_TTL = 15 * 60000, QR_TTL = 10 * 60000;
const LOCK_FAILS = 6, LOCK_WINDOW = 15 * 60000;
const PBKDF_ITER = 210000, PWD_MAX = 128;
const NEED = 2;
const FACTORS = ["tg", "pwd", "mail", "backup"];
const NAMES: Record<string, string> = { tg: "Telegram", pwd: "почта и пароль", mail: "код с почты", backup: "резервный код" };

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const randToken = () => { const b = crypto.getRandomValues(new Uint8Array(32)); return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const randLogin = () => { const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const b = crypto.getRandomValues(new Uint8Array(12)); return [...b].map((x) => A[x % A.length]).join(""); };
const randCode = (n: number) => String(crypto.getRandomValues(new Uint32Array(1))[0] % 10 ** n).padStart(n, "0");
const BK_ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const randBackup = () => { const b = crypto.getRandomValues(new Uint8Array(10)); const s = [...b].map((x) => BK_ALPHA[x % BK_ALPHA.length]).join(""); return s.slice(0, 5) + "-" + s.slice(5); };
const normBackup = (v: unknown) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const maskMail = (e: string) => { const [u, d] = String(e).split("@"); return (u?.[0] ?? "") + "•••@" + (d ?? ""); };
const hm = (t: number) => new Date(t + 5 * 3600000).toISOString().replace("T", " ").slice(0, 16) + " (UTC+5)";
async function tgSend(text: string) {
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
const fail = (kind: string) => db.from("core_attempts").insert({ kind, ok: false });
async function derive(pwd: string, saltHex: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pwd), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g)!.map((h) => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF_ITER }, key, 256));
}
let botNameCache = "";
async function botName() {
  if (botNameCache) return botNameCache;
  try { const r = await fetch(`https://api.telegram.org/bot${BOT}/getMe`); const j = await r.json(); botNameCache = j?.result?.username ?? "voobkz_bot"; } catch { botNameCache = "voobkz_bot"; }
  return botNameCache;
}

// ---- попытка входа (flow): живёт 15 минут, пока не набрано два разных способа
async function getFlow(body: any) {
  const f = body?.flow;
  if (typeof f !== "string" || f.length < 20 || f.length > 80) return null;
  const fh = await sha256("flow:" + f);
  const { data } = await db.from("core_flow").select("fh, factors, tg_code, created_at").eq("fh", fh).maybeSingle();
  if (!data) return null;
  if (Date.now() - Date.parse(data.created_at) > FLOW_TTL) { await db.from("core_flow").delete().eq("fh", fh); return null; }
  return data as { fh: string; factors: string[]; tg_code: string | null; created_at: string };
}
async function backupLeft() {
  const { count } = await db.from("core_backup").select("id", { count: "exact", head: true }).is("used_at", null);
  return count ?? 0;
}
async function begin() {
  const now = Date.now();
  await db.from("core_flow").delete().lt("created_at", new Date(now - FLOW_TTL).toISOString());
  await db.from("login_codes").delete().lt("created_at", new Date(now - 3600000).toISOString());
  await db.from("core_otp").delete().lt("created_at", new Date(now - DAY).toISOString());
  await db.from("core_attempts").delete().lt("at", new Date(now - 7 * DAY).toISOString());
  const { count } = await db.from("core_flow").select("fh", { count: "exact", head: true }).gte("created_at", new Date(now - 10 * 60000).toISOString());
  if ((count ?? 0) > 40) return { error: "Слишком много попыток, подожди несколько минут" };
  const flow = randToken();
  const { error } = await db.from("core_flow").insert({ fh: await sha256("flow:" + flow) });
  if (error) return { error: "Не удалось начать вход" };
  const c = await cfg();
  return { status: "ok", flow, need: NEED, has_pwd: !!c?.pwd_hash, has_backup: (await backupLeft()) > 0 };
}
// засчитать способ; если набралось два разных — выдать сессию
async function addFactor(fl: { fh: string; factors: string[] }, factor: string) {
  const set = [...new Set([...(fl.factors ?? []), factor])].filter((x) => FACTORS.includes(x));
  if (set.length < NEED) {
    await db.from("core_flow").update({ factors: set }).eq("fh", fl.fh);
    return { status: "need_more", factors: set, left: NEED - set.length };
  }
  await db.from("core_flow").delete().eq("fh", fl.fh);
  const token = randToken(), th = await sha256(token);
  const { error } = await db.from("sessions").insert({ token_hash: th, tg_id: ADMIN, device: "core" });
  if (error) return { error: "Не удалось создать сессию" };
  // отметка «вход подтверждён»: именно её проверяют voob-core и voob-core-pwd; писать в core_otp может только серверный ключ
  await db.from("core_otp").insert({ th, purpose: "login", payload: "2of3:" + set.join("+"), code_hash: "flow", used_at: new Date().toISOString() });
  await log("core_login", { factors: set });
  const left = await backupLeft();
  await tgSend(`🛡 Вход в VOOB CORE (WEB) подтверждён.\nСпособы: ${set.map((x) => NAMES[x]).join(" + ")}\nВремя: ${hm(Date.now())}${set.includes("backup") ? `\n\n⚠️ Использован резервный код. Осталось: ${left}.` : ""}\n\nЕсли это не ты: открой Core на своём устройстве и завершай сессии, а при подозрении на взлом поменяй почту и пароль.`);
  return { status: "ok", token, factors: set };
}

// ---- способ tg: QR-код, привязанный к попытке
async function tgStart(fl: any) {
  if (fl.factors.includes("tg")) return { status: "have" };
  const code = randLogin();
  const { error } = await db.from("login_codes").insert({ code });
  if (error) return { error: "Не удалось создать код" };
  await db.from("core_flow").update({ tg_code: code }).eq("fh", fl.fh);
  return { status: "ok", code, link: `https://t.me/${await botName()}?start=login_${code}`, expires_in: QR_TTL / 1000 };
}
async function tgPoll(fl: any) {
  if (fl.factors.includes("tg")) return { status: "have", factors: fl.factors };
  if (!fl.tg_code) return { status: "expired" };
  const { data } = await db.from("login_codes").select("tg_id, created_at").eq("code", fl.tg_code).maybeSingle();
  if (!data || Date.now() - Date.parse(data.created_at) > QR_TTL) return { status: "expired" };
  if (!data.tg_id) return { status: "pending" };
  await db.from("login_codes").delete().eq("code", fl.tg_code);
  await db.from("core_flow").update({ tg_code: null }).eq("fh", fl.fh);
  if (Number(data.tg_id) !== ADMIN) { await log("core_denied", { tg: Number(data.tg_id) }); return { status: "forbidden" }; }
  return await addFactor(fl, "tg");
}

// ---- способ pwd: почта (логин) + пароль
async function pwdCheck(fl: any, body: any) {
  if (fl.factors.includes("pwd")) return { status: "have" };
  if (await locked()) return { status: "locked" };
  const mail = String(body?.email ?? "").trim().toLowerCase(), pwd = String(body?.password ?? "");
  const c = await cfg();
  if (!c?.pwd_hash || !c?.pwd_salt) { await derive("x", "00".repeat(16)); return { status: "nopwd" }; }
  // оба сравнения выполняются всегда, чтобы по времени ответа нельзя было понять, что неверно
  const pOk = pwd.length >= 1 && pwd.length <= PWD_MAX && safeEqual(await derive(pwd, c.pwd_salt), c.pwd_hash);
  const mOk = safeEqual(await sha256("m:" + mail), await sha256("m:" + String(c.email ?? "").toLowerCase()));
  if (!(pOk && mOk)) { await fail("auth_pwd"); return { status: "wrong" }; } // одна общая ошибка: что именно неверно, не раскрываем
  return await addFactor(fl, "pwd");
}

// ---- способ mail: код на почту, привязанный к попытке
async function mailStart(fl: any) {
  if (fl.factors.includes("mail")) return { status: "have" };
  if (await locked()) return { status: "locked" };
  const th = fl.fh;
  const { data: last } = await db.from("core_otp").select("created_at").eq("th", th).eq("purpose", "flowmail").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (last && Date.now() - Date.parse(last.created_at) < MAIL_COOLDOWN) return { status: "soon" };
  const c = await cfg();
  if (!c?.email) return { status: "error", error: "Почта не настроена" };
  const code = randCode(6);
  const { error } = await db.from("core_otp").insert({ th, purpose: "flowmail", code_hash: await sha256(`coremail:flowmail:${th}:${code}`) });
  if (error) return { status: "error", error: "Не удалось создать код" };
  const ok = await sendMail(c.email, `VOOB CORE · ${code}`, mailHtml("Код для входа в VOOB CORE:", code, "Код действует 10 минут и работает один раз. Если это не ты, никому его не называй и проверь журнал в VOOB CORE."));
  return { status: ok ? "sent" : "undelivered", to: maskMail(c.email) };
}
async function mailCheck(fl: any, codeIn: unknown) {
  if (fl.factors.includes("mail")) return { status: "have" };
  if (await locked()) return { status: "locked" };
  const th = fl.fh, code = String(codeIn ?? "").replace(/\D/g, "");
  const { data: r } = await db.from("core_otp").select("id, code_hash, tries, created_at").eq("th", th).eq("purpose", "flowmail").is("used_at", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!r || Date.now() - Date.parse(r.created_at) > MAIL_TTL) return { status: "expired" };
  if (r.tries >= MAIL_TRIES) return { status: "spent" };
  if (code.length !== 6 || !safeEqual(await sha256(`coremail:flowmail:${th}:${code}`), r.code_hash)) {
    await db.from("core_otp").update({ tries: r.tries + 1 }).eq("id", r.id);
    await fail("auth_mail");
    return { status: r.tries + 1 >= MAIL_TRIES ? "spent" : "wrong", left: MAIL_TRIES - r.tries - 1 };
  }
  const { data: used } = await db.from("core_otp").update({ used_at: new Date().toISOString() }).eq("id", r.id).is("used_at", null).select("id");
  if (!used?.length) return { status: "expired" };
  return await addFactor(fl, "mail");
}

// ---- способ backup: резервный код (одноразовый, засчитывается как один способ)
async function backupCheck(fl: any, codeIn: unknown) {
  if (fl.factors.includes("backup")) return { status: "have" };
  if (await locked()) return { status: "locked" };
  const n = normBackup(codeIn);
  if (n.length !== 10) { await fail("auth_backup"); return { status: "wrong" }; }
  const h = await sha256("backup:" + n);
  // атомарно: код гасится одним запросом, повторно использовать его нельзя
  const { data } = await db.from("core_backup").update({ used_at: new Date().toISOString() }).eq("code_hash", h).is("used_at", null).select("id");
  if (!data?.length) { await fail("auth_backup"); return { status: "wrong" }; }
  return await addFactor(fl, "backup");
}

// ---- управление резервными кодами из открытого Core (нужен вход и свежее подтверждение)
async function session(body: any) {
  const tok = body?.token;
  if (typeof tok !== "string" || tok.length < 20) return { err: "Нет сессии" };
  const th = await sha256(tok);
  const { data: s } = await db.from("sessions").select("tg_id, device, created_at, last_seen").eq("token_hash", th).maybeSingle();
  if (!s || Number(s.tg_id) !== ADMIN || s.device !== "core") return { err: "Сессия недействительна — войди заново" };
  const born = Date.parse(s.created_at), seen = Date.parse(s.last_seen ?? s.created_at) || born;
  if (Date.now() - born > CORE_MAX || Date.now() - seen > CORE_IDLE) return { err: "Сессия истекла — войди заново", expired: true };
  const { data: v } = await db.from("core_otp").select("id").eq("th", th).eq("purpose", "login").not("used_at", "is", null).limit(1);
  if (!v?.length) return { err: "Вход не подтверждён", need_otp: true };
  await db.from("sessions").update({ last_seen: new Date().toISOString() }).eq("token_hash", th);
  const { data: f } = await db.from("core_otp").select("id").eq("th", th).in("purpose", ["login", "step"]).gte("used_at", new Date(Date.now() - STEP_FRESH).toISOString()).limit(1);
  return { th, fresh: !!f?.length };
}
async function backupMake() {
  const codes: string[] = [], rows: { code_hash: string }[] = [];
  for (let i = 0; i < 8; i++) { const c = randBackup(); codes.push(c); rows.push({ code_hash: await sha256("backup:" + normBackup(c)) }); }
  await db.from("core_backup").delete().gte("id", 0); // прежние коды перестают работать
  const { error } = await db.from("core_backup").insert(rows);
  if (error) return { error: "Не удалось создать коды" };
  await log("core_backup_new", { n: 8 });
  await tgSend("🔑 В VOOB CORE выпущены новые резервные коды. Старые больше не работают.");
  return { status: "ok", codes };
}

Deno.serve(async (req) => {
  const CORS = corsFor(req);
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ app: "VOOB CORE auth", ok: true });
  try {
    const body = await req.json().catch(() => ({}));
    const a = String(body?.action ?? "");
    if (a === "auth_begin") return json(await begin());
    if (a.startsWith("auth_")) {
      const fl = await getFlow(body);
      if (!fl) return json({ status: "flow_expired", error: "Попытка входа устарела — начни заново" });
      switch (a) {
        case "auth_state": return json({ status: "ok", factors: fl.factors, need: NEED });
        case "auth_tg_start": return json(await tgStart(fl));
        case "auth_tg_poll": return json(await tgPoll(fl));
        case "auth_pwd": return json(await pwdCheck(fl, body));
        case "auth_mail_start": return json(await mailStart(fl));
        case "auth_mail_verify": return json(await mailCheck(fl, body?.code));
        case "auth_backup": return json(await backupCheck(fl, body?.code));
      }
      return json({ error: "Неизвестное действие" }, 400);
    }
    if (a === "bk_status" || a === "bk_make") {
      const s = await session(body);
      if (s.err) return json({ error: s.err, expired: s.expired, need_otp: s.need_otp }, 401);
      if (a === "bk_status") {
        const { data } = await db.from("core_backup").select("used_at, created_at");
        const rows = data ?? [];
        return json({ status: "ok", total: rows.length, left: rows.filter((x: any) => !x.used_at).length, created: rows[0]?.created_at ?? null });
      }
      if (!s.fresh) return json({ error: "Подтверди действие кодом с почты", need_step: true }, 401);
      return json(await backupMake());
    }
    return json({ error: "Неизвестное действие" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "Внутренняя ошибка сервера" }, 500);
  }
});
