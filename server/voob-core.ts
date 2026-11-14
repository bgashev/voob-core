// VOOB CORE — серверная часть админ-панели (WEB core.voob.kz; вход из программы Windows отключается секретом CORE_LEGACY=off). Доступ только у создателя (ADMIN_TG_ID).
// Windows-путь (сессии device != "core"): сессия Telegram + 4-значный код из бота, как раньше.
// WEB-путь (device = "core"): QR-вход через Telegram + 6-значный код с почты, короткая сессия, свежий код для опасных действий.
// Каждое действие пишется в admin_log. Ключ базы остаётся на сервере.
// v15: платежи — PRO и магазин вместе, заявки на возврат, решения из CORE. v13: список людей отдаёт друзей, подарки, потрачено ⭐, платформы, последнюю тренировку, удаление аккаунта, заметки и теги (user_notes); действие note_set.
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const BOT = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const ADMIN = Number(Deno.env.get("ADMIN_TG_ID") ?? 0) || 702410323;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const MAIL_FROM = Deno.env.get("CORE_MAIL_FROM") ?? "VOOB CORE <onboarding@resend.dev>";
const LEGACY_OK = (Deno.env.get("CORE_LEGACY") ?? "on") !== "off"; // CORE_LEGACY=off отключит вход из программы для Windows
const ORIGINS = ["https://core.voob.kz"];
function serverKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const single = Deno.env.get("SUPABASE_SECRET_KEY");
  if (single) return single;
  try { const all = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); return all.default ?? Object.values(all)[0] ?? ""; } catch { return ""; }
}
const db = createClient(SB_URL, serverKey(), { auth: { persistSession: false } });
const corsFor = (req: Request) => {
  const o = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0], "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
  };
};
const enc = new TextEncoder();
const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))].map((x) => x.toString(16).padStart(2, "0")).join("");
const DAY = 86400000;
async function tg(method: string, payload: Record<string, unknown>) {
  try { const r = await fetch(`https://api.telegram.org/bot${BOT}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); return await r.json(); }
  catch { return { ok: false }; }
}
const openBtn = { inline_keyboard: [[{ text: "Открыть VOOB", web_app: { url: "https://bgashev.github.io/STEPS/" } }]] };
const say = (to: number, text: string, markup: unknown = openBtn) => tg("sendMessage", { chat_id: to, text, reply_markup: markup });
async function log(action: string, target: number | null, details: unknown = null) {
  await db.from("admin_log").insert({ action, target, details });
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
// PostgREST отдаёт максимум 1000 строк за раз — собираем постранично
async function all(q: (from: number, to: number) => any, cap = 50000) {
  const out: any[] = [];
  for (let i = 0; i < cap; i += 1000) {
    const { data, error } = await q(i, i + 999);
    if (error || !data) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}
// v1.8: 56 рамок мобильной версии + старые ключи (их клиент переводит в новые через FR_LEGACY)
const FRAME_KEYS = ["classic", "ears", "orbit", "pulse", "sparkle", "flame", "glitch", "crystal", "comet", "vine", "autumn", "daisy", "jelly", "runes", "sigil", "radar", "lights", "halo", "sakura", "stars", "fireflies", "wave", "bubbles", "frost", "antlers", "hearts", "cloud", "bow", "eclipse", "lava", "hud", "laurel", "wind", "pixring", "coins", "crown8", "hologram", "circuit", "eye3", "phases", "fairywing", "gummy", "blackhole", "clockwork", "neonportal", "ribbons", "waterblade", "arcflash", "paws", "matrix", "dice", "cards", "lockon", "telemetry", "claw", "doodlespace", "corrupt", "aurora", "gold", "neon", "ocean", "cyber", "emerald", "galaxy", "ice", "storm", "pixel", "plasma", "atom", "holo", "moon", "prism"];
const OTP_TTL = 10 * 60000, OTP_TRIES = 5, TRUST_DAYS = 30;

// ---- WEB: параметры
const CORE_IDLE = 30 * 60000, CORE_MAX = 8 * 3600000;        // простой 30 минут, жёсткий предел 8 часов
const MAIL_TTL = 10 * 60000, MAIL_TRIES = 3, MAIL_COOLDOWN = 30000;
const STEP_FRESH = 5 * 60000;                                  // после кода опасные действия открыты 5 минут
const LOCK_FAILS = 6, LOCK_WINDOW = 15 * 60000;                // 6 неверных кодов за 15 минут — общий запрет на 15 минут
const CHANGE_DELAY = DAY;                                      // смена почты вступает в силу через сутки
const SENS = new Set(["refund", "broadcast", "pro", "block", "unblock", "del_workout", "kick", "edit", "chg_start", "chg_confirm", "sess_end"]);

// ---- второй шаг входа для программы Windows: 4-значный код в бот. Пока сессия не подтверждена кодом, сервер не выполняет ни одного действия.
async function verified(th: string) {
  const { data } = await db.from("admin_log").select("id").eq("action", "login").eq("details->>th", th)
    .gte("at", new Date(Date.now() - TRUST_DAYS * DAY).toISOString()).limit(1);
  return !!data?.length;
}
async function otpStart(purpose = "login") {
  const { data: old } = await db.from("pin_resets").select("created_at").eq("tg_id", ADMIN).maybeSingle();
  if (old && Date.now() - new Date(old.created_at).getTime() < 20000) return { status: "soon" };
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, "0");
  const { error } = await db.from("pin_resets").upsert({ tg_id: ADMIN, code_hash: await sha256("core:" + ADMIN + ":" + code), tries: 0,
    created_at: new Date().toISOString() }, { onConflict: "tg_id" });
  if (error) return { error: "Не удалось создать код" };
  const head = purpose === "pwd" ? "🔑 <b>Пароль VOOB CORE</b>\n\nКод для изменения локального пароля:" : "🛡 <b>Вход в VOOB CORE</b>\n\nКод:";
  const text = `${head}  <code>${code}</code>\n<i>нажми на код — он скопируется</i>\n\nДействует 10 минут. Если это не ты — кто-то получил доступ к твоему Telegram-входу.`;
  let r = await tg("sendMessage", { chat_id: ADMIN, parse_mode: "HTML", text, reply_markup: { inline_keyboard: [[{ text: `Скопировать ${code}`, copy_text: { text: code } }]] } });
  if (!r?.ok) r = await tg("sendMessage", { chat_id: ADMIN, parse_mode: "HTML", text });
  return { status: r?.ok ? "sent" : "undelivered" };
}
async function otpVerify(th: string, codeIn: unknown, purpose = "login") {
  const code = String(codeIn ?? "").replace(/\D/g, "");
  const { data: r } = await db.from("pin_resets").select("code_hash, tries, created_at").eq("tg_id", ADMIN).maybeSingle();
  if (!r || Date.now() - new Date(r.created_at).getTime() > OTP_TTL) return { status: "expired" };
  if (r.tries >= OTP_TRIES) return { status: "locked" };
  if (code.length !== 4 || !safeEqual(await sha256("core:" + ADMIN + ":" + code), r.code_hash)) {
    await db.from("pin_resets").update({ tries: r.tries + 1 }).eq("tg_id", ADMIN);
    return { status: r.tries + 1 >= OTP_TRIES ? "locked" : "wrong", left: OTP_TRIES - r.tries - 1 };
  }
  await db.from("pin_resets").delete().eq("tg_id", ADMIN);
  if (purpose === "pwd") await log("pwd", null, {});
  else await log("login", null, { th });
  return { status: "ok" };
}

// ---- WEB: QR-вход (коды живут в тех же login_codes, что и вход основного приложения; бот закрепляет код за нажавшим Start)
const randToken = () => { const b = crypto.getRandomValues(new Uint8Array(32)); return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const randLogin = () => { const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const b = crypto.getRandomValues(new Uint8Array(12)); return [...b].map((x) => A[x % A.length]).join(""); };
const randCode = (n: number) => String(crypto.getRandomValues(new Uint32Array(1))[0] % 10 ** n).padStart(n, "0");
const maskMail = (e: string) => { const [u, d] = String(e).split("@"); return (u?.[0] ?? "") + "•••@" + (d ?? ""); };
const hm = (t: number) => new Date(t + 5 * 3600000).toISOString().replace("T", " ").slice(0, 16) + " (UTC+5)";
let botNameCache = "";
async function botName() {
  if (botNameCache) return botNameCache;
  const me = await tg("getMe", {});
  botNameCache = me?.result?.username ?? "voobkz_bot";
  return botNameCache;
}
async function coreLoginStart() {
  const now = Date.now();
  await db.from("login_codes").delete().lt("created_at", new Date(now - 3600000).toISOString());
  await db.from("core_otp").delete().lt("created_at", new Date(now - DAY).toISOString());
  await db.from("core_attempts").delete().lt("at", new Date(now - 7 * DAY).toISOString());
  const { count } = await db.from("login_codes").select("code", { count: "exact", head: true }).gte("created_at", new Date(now - 10 * 60000).toISOString());
  if ((count ?? 0) > 40) return { error: "Слишком много попыток, подожди несколько минут" };
  const code = randLogin();
  const { error } = await db.from("login_codes").insert({ code });
  if (error) return { error: "Не удалось создать код" };
  return { status: "ok", code, link: `https://t.me/${await botName()}?start=login_${code}`, expires_in: 600 };
}
async function coreLoginPoll(body: any) {
  const code = String(body?.code ?? "");
  if (!/^[A-Z0-9]{8,32}$/.test(code)) return { error: "Неверный код" };
  const { data } = await db.from("login_codes").select("tg_id, created_at").eq("code", code).maybeSingle();
  if (!data || Date.now() - Date.parse(data.created_at) > 600000) return { status: "expired" };
  if (!data.tg_id) return { status: "pending" };
  await db.from("login_codes").delete().eq("code", code);
  if (Number(data.tg_id) !== ADMIN) { await log("core_denied", Number(data.tg_id), {}); return { status: "forbidden" }; } // чужому сессия не создаётся
  const token = randToken();
  const { error } = await db.from("sessions").insert({ token_hash: await sha256(token), tg_id: ADMIN, device: "core" });
  if (error) return { error: "Не удалось создать сессию" };
  return { status: "ok", token };
}

// ---- WEB: почта для кодов (Resend)
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
const CODE_FOOT = "Код действует 10 минут и работает один раз. Если это не ты, никому его не называй и проверь журнал в VOOB CORE.";
async function cfg() { const { data } = await db.from("core_config").select("*").eq("id", 1).maybeSingle(); return data as any; }
// смена почты вступает в силу лениво: при первом запросе после истечения задержки
async function applyPending() {
  const c = await cfg();
  if (c?.pending_email && c.pending_apply_at && Date.parse(c.pending_apply_at) <= Date.now()) {
    await db.from("core_config").update({ email: c.pending_email, pending_email: null, pending_requested_at: null, pending_apply_at: null, updated_at: new Date().toISOString() }).eq("id", 1);
    await log("core_email_applied", null, {});
    await tg("sendMessage", { chat_id: ADMIN, text: `📧 Почта для кодов VOOB CORE изменена на ${maskMail(c.pending_email)}.` });
    return await cfg();
  }
  return c;
}
async function locked() {
  const { count } = await db.from("core_attempts").select("id", { count: "exact", head: true }).eq("ok", false).gte("at", new Date(Date.now() - LOCK_WINDOW).toISOString());
  return (count ?? 0) >= LOCK_FAILS;
}
async function issue(th: string, purpose: string, payload: string | null = null) {
  const code = randCode(6);
  const { error } = await db.from("core_otp").insert({ th, purpose, payload, code_hash: await sha256(`coremail:${purpose}:${th}:${code}`) });
  return error ? null : code;
}
async function cooling(th: string, purpose: string) {
  const { data: last } = await db.from("core_otp").select("created_at").eq("th", th).eq("purpose", purpose).order("created_at", { ascending: false }).limit(1).maybeSingle();
  return !!last && Date.now() - Date.parse(last.created_at) < MAIL_COOLDOWN;
}
async function codeCheck(th: string, purpose: string, codeIn: unknown, consume = true) {
  if (await locked()) return { status: "locked" } as any;
  const code = String(codeIn ?? "").replace(/\D/g, "");
  const { data: r } = await db.from("core_otp").select("id, code_hash, tries, created_at, payload").eq("th", th).eq("purpose", purpose).is("used_at", null)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!r || Date.now() - Date.parse(r.created_at) > MAIL_TTL) return { status: "expired" } as any;
  if (r.tries >= MAIL_TRIES) return { status: "spent" } as any;
  if (code.length !== 6 || !safeEqual(await sha256(`coremail:${purpose}:${th}:${code}`), r.code_hash)) {
    await db.from("core_otp").update({ tries: r.tries + 1 }).eq("id", r.id);
    await db.from("core_attempts").insert({ kind: purpose, ok: false });
    return { status: r.tries + 1 >= MAIL_TRIES ? "spent" : "wrong", left: MAIL_TRIES - r.tries - 1 } as any;
  }
  if (consume) await db.from("core_otp").update({ used_at: new Date().toISOString() }).eq("id", r.id).is("used_at", null);
  return { status: "ok", id: r.id, payload: r.payload } as any;
}
async function mailStart(th: string, purpose: string) {
  if (await locked()) return { status: "locked" };
  if (await cooling(th, purpose)) return { status: "soon" };
  const c = await applyPending();
  if (!c?.email) return { status: "error", error: "Почта не настроена" };
  const code = await issue(th, purpose);
  if (!code) return { status: "error", error: "Не удалось создать код" };
  const lead = purpose === "step" ? "Код для подтверждения опасного действия:" : "Код для входа в VOOB CORE:";
  const ok = await sendMail(c.email, `VOOB CORE · ${code}`, mailHtml(lead, code, CODE_FOOT));
  return { status: ok ? "sent" : "undelivered", to: maskMail(c.email) };
}
async function mailVerify(th: string, purpose: string, code: unknown) {
  const r = await codeCheck(th, purpose, code);
  if (r.status !== "ok") return r;
  if (purpose === "login") {
    await log("core_login", null, {});
    await tg("sendMessage", { chat_id: ADMIN, text: `🛡 Вход в VOOB CORE (WEB) подтверждён.\nВремя: ${hm(Date.now())}\n\nЕсли это не ты: открой Core на своём устройстве и завершай сессии, а при подозрении на взлом поменяй почту в базе.` });
  } else await log("core_step", null, {});
  return { status: "ok" };
}
async function coreVerified(th: string) {
  const { data } = await db.from("core_otp").select("id").eq("th", th).eq("purpose", "login").not("used_at", "is", null).limit(1);
  return !!data?.length;
}
async function coreFresh(th: string) {
  const { data } = await db.from("core_otp").select("id").eq("th", th).in("purpose", ["login", "step"]).gte("used_at", new Date(Date.now() - STEP_FRESH).toISOString()).limit(1);
  return !!data?.length;
}
// ---- WEB: смена почты: свежий код со старой, код на новую, код в бот, затем задержка 24 часа и возможность отмены
async function chgStart(th: string, emailIn: unknown) {
  const email = String(emailIn ?? "").trim().toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email) || email.length > 254) return { error: "Неверный адрес почты" };
  const c = await applyPending();
  if (c?.email && c.email.toLowerCase() === email) return { error: "Это уже текущая почта" };
  if (c?.pending_email) return { error: "Смена уже запланирована. Отмени её, чтобы начать заново" };
  if (await locked()) return { status: "locked" };
  if (await cooling(th, "chg_new")) return { status: "soon" };
  const cn = await issue(th, "chg_new", email), ct = await issue(th, "chg_tg", email);
  if (!cn || !ct) return { error: "Не удалось создать коды" };
  const ok = await sendMail(email, `VOOB CORE · ${cn}`, mailHtml(`Код для подтверждения нового адреса VOOB CORE:`, cn, CODE_FOOT));
  if (!ok) {
    await db.from("core_otp").delete().eq("th", th).in("purpose", ["chg_new", "chg_tg"]).is("used_at", null);
    return { status: "undelivered", error: "Письмо на новый адрес не доставлено" };
  }
  await tg("sendMessage", { chat_id: ADMIN, parse_mode: "HTML", text: `📧 <b>Смена почты VOOB CORE</b>\n\nНовый адрес: ${maskMail(email)}\nКод:  <code>${ct}</code>\n\nЕсли это не ты — ничего не вводи.` });
  return { status: "sent", to: maskMail(email) };
}
async function chgConfirm(th: string, codeNew: unknown, codeTg: unknown) {
  const a = await codeCheck(th, "chg_new", codeNew, false);
  if (a.status !== "ok") return { ...a, which: "mail" };
  const b = await codeCheck(th, "chg_tg", codeTg, false);
  if (b.status !== "ok") return { ...b, which: "bot" };
  if (!a.payload || a.payload !== b.payload) return { status: "error", error: "Коды относятся к разным адресам" };
  const now = Date.now();
  await db.from("core_otp").update({ used_at: new Date(now).toISOString() }).in("id", [a.id, b.id]);
  const c = await cfg();
  const at = new Date(now + CHANGE_DELAY).toISOString();
  await db.from("core_config").update({ pending_email: a.payload, pending_requested_at: new Date(now).toISOString(), pending_apply_at: at, updated_at: new Date(now).toISOString() }).eq("id", 1);
  await log("core_email_change", null, { to: maskMail(a.payload), apply_at: at });
  await tg("sendMessage", { chat_id: ADMIN, text: `📧 Смена почты VOOB CORE запланирована.\n\nНовый адрес: ${maskMail(a.payload)}\nВступит в силу: ${hm(Date.parse(at))}\n\nЭто не ты? Зайди в VOOB CORE и отмени смену: до этого момента коды идут на старую почту.` });
  if (c?.email) await sendMail(c.email, "VOOB CORE · запланирована смена почты", mailHtml(`Запланирована смена почты для кодов VOOB CORE на ${maskMail(a.payload)}.`, "", `Вступит в силу: ${hm(Date.parse(at))}. Это не ты? Зайди в VOOB CORE и отмени смену.`));
  return { status: "ok", apply_at: at };
}
async function chgCancel() {
  const c = await cfg();
  if (!c?.pending_email) return { status: "ok" };
  await db.from("core_config").update({ pending_email: null, pending_requested_at: null, pending_apply_at: null, updated_at: new Date().toISOString() }).eq("id", 1);
  await log("core_email_cancel", null, {});
  await tg("sendMessage", { chat_id: ADMIN, text: "📧 Смена почты VOOB CORE отменена." });
  return { status: "ok" };
}

async function photoB64(userId: number, big: boolean, max = false) {
  const ph = await tg("getUserProfilePhotos", { user_id: userId, limit: 1 });
  const sizes: any[] = ph?.result?.photos?.[0] ?? [];
  if (!ph?.ok || !sizes.length) return { ok: false, reason: "no_photo" };
  const best = max ? sizes.reduce((a, b) => (b.width > a.width ? b : a)) : big ? sizes.reduce((a, b) => (Math.abs(b.width - 320) < Math.abs(a.width - 320) ? b : a))
    : (sizes.find((s) => s.width >= 150) ?? sizes[sizes.length - 1]);
  const f = await tg("getFile", { file_id: best.file_id });
  if (!f?.ok || !f.result?.file_path) return { ok: false, reason: "no_file" };
  const r = await fetch(`https://api.telegram.org/file/bot${BOT}/${f.result.file_path}`);
  if (!r.ok) return { ok: false, reason: "download" };
  const buf = new Uint8Array(await r.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { ok: true, b64: btoa(bin) };
}

async function overview(body: any) {
  const days = Math.max(7, Math.min(730, Math.round(Number(body?.days) || 30)));
  const now = Date.now(), start = now - days * DAY, pstart = now - 2 * days * DAY;
  const sinceP = new Date(pstart).toISOString();
  const [{ count: users }, us, ses, { data: subs }, pays0, { count: fbNew }, recs, { count: blocked }, shopP, { count: rfNew }] = await Promise.all([
    db.from("users").select("tg_id", { count: "exact", head: true }),
    all((a, b) => db.from("users").select("created_at").gte("created_at", sinceP).order("created_at").range(a, b)),
    all((a, b) => db.from("sessions").select("tg_id, last_seen").gte("last_seen", sinceP).order("last_seen").range(a, b)),
    db.from("pro_subs").select("tg_id").gt("until", new Date().toISOString()),
    all((a, b) => db.from("pro_payments").select("stars, created_at, refunded_at").gte("created_at", sinceP).order("created_at").range(a, b)),
    db.from("feedback").select("id", { count: "exact", head: true }).eq("status", "new"),
    all((a, b) => db.from("records").select("tg_id, updated, deleted").eq("kind", "workout").gte("updated", pstart).order("updated").range(a, b), 200000),
    db.from("users").select("tg_id", { count: "exact", head: true }).eq("blocked", true),
    all((a, b) => db.from("shop_owned").select("stars, created_at, refunded_at").gte("created_at", sinceP).order("created_at").range(a, b)),
    db.from("refund_requests").select("id", { count: "exact", head: true }).eq("status", "pending"),
  ]);
  const pays = [...pays0, ...shopP];
  const list: string[] = [];
  for (let i = 2 * days - 1; i >= 0; i--) list.push(iso(new Date(now - i * DAY)));
  const nu: Record<string, number> = {}, act: Record<string, Set<number>> = {}, wk: Record<string, number> = {}, rev: Record<string, number> = {};
  const cur = { active: new Set<number>(), new: 0, stars: 0, workouts: 0 }, prev = { active: new Set<number>(), new: 0, stars: 0, workouts: 0 };
  const per = (t: number) => (t >= start ? cur : prev);
  for (const u of us) { const t = Date.parse(u.created_at); const d = iso(new Date(t)); nu[d] = (nu[d] ?? 0) + 1; per(t).new++; }
  for (const r of recs) { if (r.deleted) continue; const t = Number(r.updated), d = iso(new Date(t)); wk[d] = (wk[d] ?? 0) + 1; (act[d] ??= new Set()).add(r.tg_id); per(t).workouts++; per(t).active.add(r.tg_id); }
  for (const s of ses) { const t = Date.parse(s.last_seen), d = iso(new Date(t)); (act[d] ??= new Set()).add(s.tg_id); per(t).active.add(s.tg_id); }
  for (const p of pays) { if (p.refunded_at) continue; const t = Date.parse(p.created_at), d = iso(new Date(t)); rev[d] = (rev[d] ?? 0) + p.stars; per(t).stars += p.stars; }
  const today = iso(new Date()), yest = iso(new Date(now - DAY));
  const pack = (x: any) => ({ active: x.active.size, new: x.new, stars: x.stars, workouts: x.workouts });
  return {
    days, users: users ?? 0, blocked: blocked ?? 0, pro: (subs ?? []).length, fb_new: fbNew ?? 0, rf_new: rfNew ?? 0,
    active_today: (act[today] ?? new Set()).size, active_yesterday: (act[yest] ?? new Set()).size,
    cur: pack(cur), prev: pack(prev),
    series: list.slice(-days).map((d) => ({ d, new: nu[d] ?? 0, active: (act[d] ?? new Set()).size, workouts: wk[d] ?? 0, stars: rev[d] ?? 0 })),
  };
}

// новые люди и покупки PRO с момента последнего визита — для уведомлений в боковой панели
async function events(body: any) {
  const since = new Date(Math.max(Date.now() - 60 * DAY, Date.parse(String(body?.since ?? "")) || Date.now() - 7 * DAY)).toISOString();
  const [{ data: nu, count }, { data: pays }] = await Promise.all([
    db.from("users").select("tg_id, first_name, handle, username, created_at", { count: "exact" }).gt("created_at", since).order("created_at", { ascending: false }).limit(8),
    db.from("pro_payments").select("tg_id, payer_id, plan, days, stars, created_at, refunded_at").gt("created_at", since).order("created_at", { ascending: false }).limit(8),
  ]);
  const ids = [...new Set((pays ?? []).flatMap((p: any) => [p.tg_id, p.payer_id]).filter(Boolean))];
  const { data: us } = ids.length ? await db.from("users").select("tg_id, first_name, handle, username").in("tg_id", ids) : { data: [] };
  const m = new Map((us ?? []).map((u: any) => [u.tg_id, u]));
  return { since, new_count: count ?? 0, new_users: nu ?? [],
    pro: (pays ?? []).filter((p: any) => !p.refunded_at).map((p: any) => ({ ...p, user: m.get(p.tg_id) ?? null, payer: p.payer_id ? m.get(p.payer_id) ?? null : null })) };
}

// рамки выбранных людей: читаем все настройки одним проходом (список людей большой — фильтр in(...) раздул бы адрес запроса)
async function frameMap() {
  const out = new Map<number, string>();
  const rows = await all((a, b) => db.from("records").select("tg_id, data, deleted").eq("kind", "meta").eq("id", "settings").range(a, b));
  for (const r of rows) { const f = r.deleted ? null : r.data?.frame; if (typeof f === "string" && f) out.set(r.tg_id, f); }
  return out;
}
// v1.545: рамки — только PRO (и создателю); отдельно подаренных рамок больше нет
const effFrame = (want: string | undefined, pro: boolean, creator: boolean, _owned: string[] = []) =>
  !want ? null : want === "classic" || pro || creator ? want : "classic";

async function users(body: any) {
  const q = String(body?.q ?? "").trim().replace(/^@/, "").replace(/[,()%]/g, "");
  const f = String(body?.filter ?? "all");
  let r = db.from("users").select("tg_id, first_name, tg_first, vname, username, handle, created_at, last_seen, visits, blocked, block_reason, private, hide_feed, socials, delete_at")
    .order("last_seen", { ascending: false, nullsFirst: false }).limit(2000);
  if (q) r = /^\d+$/.test(q) ? r.eq("tg_id", Number(q)) : r.or(`first_name.ilike.%${q}%,username.ilike.%${q}%,handle.ilike.%${q}%,tg_first.ilike.%${q}%`);
  if (f === "blocked") r = r.eq("blocked", true);
  if (f === "new") r = r.gte("created_at", new Date(Date.now() - 7 * DAY).toISOString());
  if (f === "inactive") r = r.lt("last_seen", new Date(Date.now() - 14 * DAY).toISOString());
  const { data: list, error } = await r;
  if (error) return { error: error.message };
  const [{ data: subs }, wk, fm, fr, gf, pays, shop, ses, { data: nts }] = await Promise.all([
    db.from("pro_subs").select("tg_id, until"),
    all((a, b) => db.from("records").select("tg_id, updated").eq("kind", "workout").eq("deleted", false).range(a, b), 300000),
    frameMap(),
    all((a, b) => db.from("friends").select("a").range(a, b)),
    all((a, b) => db.from("gifts").select("from_id, to_id").range(a, b)),
    all((a, b) => db.from("pro_payments").select("tg_id, payer_id, stars, refunded_at").range(a, b)),
    all((a, b) => db.from("shop_owned").select("tg_id, payer_id, stars, refunded_at").range(a, b)),
    all((a, b) => db.from("sessions").select("tg_id, device").range(a, b)),
    db.from("user_notes").select("tg_id, note, tags"),
  ]);
  const pro = new Map<number, string>((subs ?? []).map((s: any) => [s.tg_id, s.until] as [number, string]));
  const wn = new Map<number, number>(), wl = new Map<number, number>();
  for (const w of wk ?? []) { wn.set(w.tg_id, (wn.get(w.tg_id) ?? 0) + 1); const t = Number(w.updated) || 0; if (t > (wl.get(w.tg_id) ?? 0)) wl.set(w.tg_id, t); }
  const fc = new Map<number, number>(), gin = new Map<number, number>(), gout = new Map<number, number>();
  for (const x of fr ?? []) fc.set(x.a, (fc.get(x.a) ?? 0) + 1);
  for (const g of gf ?? []) { gin.set(g.to_id, (gin.get(g.to_id) ?? 0) + 1); gout.set(g.from_id, (gout.get(g.from_id) ?? 0) + 1); }
  const spent = new Map<number, { stars: number; n: number }>();
  for (const p of [...(pays ?? []), ...(shop ?? [])]) {
    if (p.refunded_at) continue;
    const k = Number(p.payer_id ?? p.tg_id), s = spent.get(k) ?? { stars: 0, n: 0 };
    s.stars += Number(p.stars) || 0; s.n++; spent.set(k, s);
  }
  const plat = new Map<number, Set<string>>();
  for (const s of ses ?? []) { if (s.device && s.device !== "core") (plat.get(s.tg_id) ?? plat.set(s.tg_id, new Set()).get(s.tg_id)!).add(s.device); }
  const nt = new Map<number, any>((nts ?? []).map((n: any) => [n.tg_id, n]));
  let out = (list ?? []).map((u: any) => ({ ...u, pro_until: pro.get(u.tg_id) ?? null, pro: !!pro.get(u.tg_id) && new Date(pro.get(u.tg_id)!).getTime() > Date.now(),
    workouts: wn.get(u.tg_id) ?? 0, creator: u.tg_id === ADMIN }))
    .map((u: any) => ({ ...u, frame: effFrame(fm.get(u.tg_id), u.pro, u.creator),
      last_workout: wl.get(u.tg_id) ? new Date(wl.get(u.tg_id)!).toISOString() : null,
      friends: fc.get(u.tg_id) ?? 0, gifts_in: gin.get(u.tg_id) ?? 0, gifts_out: gout.get(u.tg_id) ?? 0,
      stars: spent.get(u.tg_id)?.stars ?? 0, paid: spent.get(u.tg_id)?.n ?? 0,
      platforms: [...(plat.get(u.tg_id) ?? [])].sort(),
      note: nt.get(u.tg_id)?.note ?? "", tags: nt.get(u.tg_id)?.tags ?? [] }));
  if (f === "pro") out = out.filter((u: any) => u.pro);
  return { users: out };
}

// заметка и теги: note — заменить текст; add_tags / del_tags — добавить и убрать теги (до 8 на человека, до 16 символов)
async function noteSet(id: number, body: any) {
  const { data: u } = await db.from("users").select("tg_id").eq("tg_id", id).maybeSingle();
  if (!u) return { error: "Нет такого пользователя" };
  const { data: cur } = await db.from("user_notes").select("note, tags").eq("tg_id", id).maybeSingle();
  const norm = (x: unknown) => String(x ?? "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 16);
  const list = (x: unknown) => (Array.isArray(x) ? x.map(norm).filter(Boolean) : []);
  let note = cur?.note ?? "";
  if (typeof body?.note === "string") note = body.note.trim().slice(0, 600);
  const del = list(body?.del_tags), add = list(body?.add_tags);
  const tags = [...new Set([...(cur?.tags ?? []).filter((t: string) => !del.includes(t)), ...add])].slice(0, 8);
  if (!note && !tags.length) await db.from("user_notes").delete().eq("tg_id", id);
  else {
    const { error } = await db.from("user_notes").upsert({ tg_id: id, note, tags, updated_at: new Date().toISOString() }, { onConflict: "tg_id" });
    if (error) return { error: error.message };
  }
  await log("note", id, { tags, note: note.slice(0, 80) });
  return { status: "ok", note, tags };
}

async function user(id: number) {
  const [{ data: u }, { data: sub }, { data: pays }, { data: gin }, { data: gout }, { data: fr }, { data: fb }, recsAll, { data: ses }, { data: nt }, { data: shopU }, { data: rqU }] = await Promise.all([
    db.from("users").select("*").eq("tg_id", id).maybeSingle(),
    db.from("pro_subs").select("*").eq("tg_id", id).maybeSingle(),
    db.from("pro_payments").select("*").or(`tg_id.eq.${id},payer_id.eq.${id}`).order("created_at", { ascending: false }).limit(50),
    db.from("gifts").select("id, from_id, kind, created_at, claimed_at").eq("to_id", id).order("id", { ascending: false }).limit(100),
    db.from("gifts").select("id, to_id, kind, created_at").eq("from_id", id).order("id", { ascending: false }).limit(100),
    db.from("friends").select("b").eq("a", id),
    db.from("feedback").select("*").or(`from_id.eq.${id},target_id.eq.${id}`).order("id", { ascending: false }).limit(50),
    all((a, b) => db.from("records").select("kind, id, data, deleted, updated").eq("tg_id", id).in("kind", ["workout", "weight", "meta"]).range(a, b)),
    db.from("sessions").select("device, created_at, last_seen").eq("tg_id", id).order("last_seen", { ascending: false }).limit(10),
    db.from("user_notes").select("note, tags").eq("tg_id", id).maybeSingle(),
    db.from("shop_owned").select("*").or(`tg_id.eq.${id},payer_id.eq.${id}`).order("created_at", { ascending: false }).limit(50),
    db.from("refund_requests").select("id, charge_id, src, reason, status, created_at").eq("tg_id", id).order("created_at", { ascending: false }).limit(30),
  ]);
  if (!u) return { error: "Пользователь не найден" };
  // откуда у человека PRO и покупки: использованные промокоды, ручные выдачи, имена дарителей
  const [{ data: pus }, { data: grants }] = await Promise.all([
    db.from("promo_uses").select("code, used_at").eq("tg_id", id).order("used_at", { ascending: false }).limit(50),
    db.from("admin_log").select("at, action, details").eq("target", id).in("action", ["pro", "gift"]).order("id", { ascending: false }).limit(50),
  ]);
  const pcodes = (pus ?? []).map((x: any) => x.code);
  const { data: pcs } = pcodes.length ? await db.from("promo_codes").select("code, kind, value, note").in("code", pcodes) : { data: [] };
  const pcm = new Map((pcs ?? []).map((c: any) => [c.code, c]));
  const promos = (pus ?? []).map((x: any) => ({ ...x, kind: pcm.get(x.code)?.kind ?? null, value: pcm.get(x.code)?.value ?? null, note: pcm.get(x.code)?.note ?? null }));
  const nm = await userMap([...(pays ?? []), ...(shopU ?? [])].flatMap((x: any) => [x.tg_id, x.payer_id]).concat((gin ?? []).map((x: any) => x.from_id)));
  const names: Record<string, any> = {};
  for (const [k, v] of nm) names[k] = { tg_id: v.tg_id, first_name: v.first_name, handle: v.handle };
  const recsA: any[] = recsAll as any[];
  const fids = (fr ?? []).map((x: any) => x.b);
  const { data: fu } = fids.length ? await db.from("users").select("tg_id, first_name, handle, username, blocked").in("tg_id", fids) : { data: [] };
  const ws = recsA.filter((r: any) => r.kind === "workout" && !r.deleted).map((r: any) => ({ rid: r.id, ...r.data }))
    .sort((a: any, b: any) => (a.date < b.date ? 1 : -1));
  const weights = recsA.filter((r: any) => r.kind === "weight" && !r.deleted).map((r: any) => r.data).sort((a: any, b: any) => (a.date < b.date ? 1 : -1)).slice(0, 30);
  const meta = Object.fromEntries(recsA.filter((r: any) => r.kind === "meta" && !r.deleted).map((r: any) => [r.id, r.data]));
  const proOn = !!sub?.until && Date.parse(sub.until) > Date.now();
  const frame = effFrame((meta as any).settings?.frame, proOn, id === ADMIN);
  return { user: u, pro: sub, payments: [...(pays ?? []).map((x: any) => ({ ...x, src: "pro" })), ...(shopU ?? []).map((x: any) => ({ ...x, src: "shop" }))].sort((a: any, b: any) => (a.created_at < b.created_at ? 1 : -1)), refund_reqs: rqU ?? [], promos, grants: grants ?? [], names, admin_id: ADMIN, gifts_in: gin ?? [], gifts_out: gout ?? [], friends: fu ?? [], feedback: fb ?? [],
    workouts: ws, workouts_total: ws.length, weights, meta, sessions: ses ?? [], frame, frames: [], creator: id === ADMIN,
    note: nt?.note ?? "", tags: nt?.tags ?? [] };
}

async function block(id: number, on: boolean, reason: string, notify: boolean) {
  if (id === ADMIN) return { error: "Себя заблокировать нельзя" };
  const { data: u } = await db.from("users").select("blocked, hide_feed, handle, handle_prev, hide_feed_prev").eq("tg_id", id).maybeSingle();
  if (!u) return { error: "Нет такого пользователя" };
  if (on && !u.blocked) {
    await db.from("users").update({ blocked: true, block_reason: reason || null, blocked_at: new Date().toISOString(),
      hide_feed_prev: !!u.hide_feed, hide_feed: true, handle_prev: u.handle, handle: null }).eq("tg_id", id);
    if (notify) await say(id, `⛔ Твой аккаунт в VOOB ограничен${reason ? ": " + reason : ""}.\n\nТрекер работает, но лента, подарки, заявки в друзья и жалобы недоступны.`);
  } else if (!on && u.blocked) {
    await db.from("users").update({ blocked: false, block_reason: null, blocked_at: null, hide_feed: !!u.hide_feed_prev,
      handle: u.handle_prev ?? null, handle_prev: null }).eq("tg_id", id);
    if (notify) await say(id, "✅ Ограничения в VOOB сняты. С возвращением!");
  }
  await log(on ? "block" : "unblock", id, { reason });
  return { status: "ok" };
}

async function gift(id: number, kind: string, notify: boolean) {
  const { data: gt } = await db.from("gift_types").select("kind, emoji, title").eq("kind", kind).maybeSingle();
  if (!gt || kind === "pro") return { error: "Неизвестный подарок" };
  const { error } = await db.from("gifts").insert({ from_id: ADMIN, to_id: id, kind });
  if (error) return { error: error.message };
  if (notify) await say(id, `🎁 Команда VOOB дарит тебе ${gt.emoji} «${gt.title}»!\n\nОткрой VOOB, чтобы получить подарок.`);
  await log("gift", id, { kind });
  return { status: "ok" };
}

async function grantPro(id: number, days: number, notify: boolean) {
  days = Math.max(-3650, Math.min(3650, Math.round(days)));
  const { data: cur } = await db.from("pro_subs").select("until").eq("tg_id", id).maybeSingle();
  const base = cur?.until && new Date(cur.until).getTime() > Date.now() ? new Date(cur.until).getTime() : Date.now();
  const until = new Date(base + days * DAY).toISOString();
  const { error } = await db.from("pro_subs").upsert({ tg_id: id, until, plan: "gift", updated_at: new Date().toISOString(), bonus_used: false }, { onConflict: "tg_id" });
  if (error) return { error: error.message };
  if (notify && days > 0) await say(id, `👑 Команда VOOB дарит тебе PRO на ${days} дн.!\n\nПодписка действует до ${until.slice(8, 10)}.${until.slice(5, 7)}.${until.slice(0, 4)}.`);
  await log("pro", id, { days, until });
  return { status: "ok", until };
}

// запись в «настройки» или «профиль» человека через синхронизацию: изменение разойдётся на все его устройства
async function pushMeta(id: number, key: string, patch: Record<string, unknown>) {
  const { data: r } = await db.from("records").select("data, updated, deleted").eq("tg_id", id).eq("kind", "meta").eq("id", key).maybeSingle();
  const data = { ...((r && !r.deleted && r.data) || {}) } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete data[k]; else data[k] = v; }
  const { error } = await db.rpc("sync_push", { p_tg: id, p_rows: [{ kind: "meta", id: key, data, updated: Math.max(Date.now(), Number(r?.updated ?? 0) + 1), deleted: false }] });
  return error ? error.message : null;
}
const SOC_RE: Record<string, RegExp> = { ig: /^[A-Za-z0-9._]{1,30}$/, tg: /^[A-Za-z][A-Za-z0-9_]{3,31}$/, tt: /^[A-Za-z0-9._]{2,24}$/, yt: /^[A-Za-z0-9._-]{3,30}$/ };
async function edit(id: number, field: string, value: unknown) {
  const upd: Record<string, unknown> = {};
  if (field === "handle") {
    const h = value ? String(value).trim().replace(/^@/, "") : "";
    if (h && !/^[A-Za-z0-9_.]{3,20}$/.test(h)) return { error: "Ник: 3–20 символов, латиница, цифры, _ и ." };
    upd.handle = h || null;
  } else if (field === "socials") upd.socials = {};
  else if (field.startsWith("social:")) {
    const net = field.slice(7);
    if (!SOC_RE[net]) return { error: "Неизвестная соцсеть" };
    const { data: u } = await db.from("users").select("socials").eq("tg_id", id).maybeSingle();
    const cur = { ...((u?.socials as any) ?? {}) };
    const v = value ? String(value).trim().replace(/^@/, "") : "";
    if (v && !SOC_RE[net].test(v)) return { error: "Неверный ник для этой соцсети" };
    if (v) cur[net] = v; else delete cur[net];
    upd.socials = cur;
  }
  else if (field === "private") upd.private = !!value;
  else if (field === "hide_feed") upd.hide_feed = !!value;
  else if (field === "name") {
    const n = value ? String(value).trim().slice(0, 32) : "";
    const e = await pushMeta(id, "profile", { name: n || null });
    if (e) return { error: e };
    await log("edit", id, { field, value: n });
    return { status: "ok" };
  } else if (field === "frame") {
    const f = value ? String(value) : "";
    if (f && !FRAME_KEYS.includes(f)) return { error: "Неизвестная рамка" };
    const e = await pushMeta(id, "settings", { frame: f || null });
    if (e) return { error: e };
    await log("edit", id, { field, value: f });
    return { status: "ok" };
  } else if (field === "badge") {
    // v1.546: значок у имени — пустое значение = «Печать», ключ — как в voob-badges (латиница 3–12)
    const b = value ? String(value) : "";
    if (b && !/^[a-z]{3,12}$/.test(b)) return { error: "Неизвестный значок" };
    const e = await pushMeta(id, "settings", { badge: b || null });
    if (e) return { error: e };
    await log("edit", id, { field, value: b });
    return { status: "ok" };
  } else return { error: "Нельзя менять это поле" };
  const { error } = await db.from("users").update(upd).eq("tg_id", id);
  if (error) return { error: error.code === "23505" ? "Ник занят" : error.message };
  await log("edit", id, { field, value });
  return { status: "ok" };
}

async function kick(id: number) {
  if (id === ADMIN) return { error: "Свои сеансы так не завершить — нажми «Выйти»" };
  const { count } = await db.from("sessions").delete({ count: "exact" }).eq("tg_id", id);
  await log("kick", id, { n: count ?? 0 });
  return { status: "ok", n: count ?? 0 };
}

async function delWorkout(id: number, rid: string) {
  const { data: r } = await db.from("records").select("data, updated").eq("tg_id", id).eq("kind", "workout").eq("id", rid).maybeSingle();
  if (!r) return { error: "Тренировка не найдена" };
  // через ту же функцию, что и синхронизация: удаление разойдётся на все устройства человека
  const { error } = await db.rpc("sync_push", { p_tg: id, p_rows: [{ kind: "workout", id: rid, data: r.data ?? {}, updated: Math.max(Date.now(), Number(r.updated) + 1), deleted: true }] });
  if (error) return { error: error.message };
  await log("del_workout", id, { rid, date: (r.data as any)?.date });
  return { status: "ok" };
}

async function feedback(body: any) {
  let r = db.from("feedback").select("*").order("id", { ascending: false }).limit(300);
  if (body?.status && body.status !== "all") r = r.eq("status", body.status);
  if (body?.type && body.type !== "all") r = r.eq("type", body.type);
  const { data } = await r;
  const ids = [...new Set((data ?? []).flatMap((x: any) => [x.from_id, x.target_id]).filter(Boolean))];
  const { data: us } = ids.length ? await db.from("users").select("tg_id, first_name, handle, username").in("tg_id", ids) : { data: [] };
  const m = new Map((us ?? []).map((u: any) => [u.tg_id, u]));
  return { items: (data ?? []).map((x: any) => ({ ...x, from: m.get(x.from_id) ?? null, target: x.target_id ? m.get(x.target_id) ?? null : null })) };
}

// люди по списку id — пачками, чтобы адрес запроса не раздувался
async function userMap(ids: any[]) {
  const out = new Map<number, any>(), u = [...new Set(ids.map(Number).filter(Boolean))];
  for (let i = 0; i < u.length; i += 120) {
    const { data } = await db.from("users").select("tg_id, first_name, handle, username, blocked").in("tg_id", u.slice(i, i + 120));
    for (const x of data ?? []) out.set(x.tg_id, x);
  }
  return out;
}

const REFUND_WINDOW_H = 48; // как в боте: без причины «не сработало» вернуть можно в течение 48 часов
// все платежи (PRO и магазин), заявки на возврат, люди и подписки — одним ответом; фильтры и итоги считает страница
async function payments(_body: any) {
  const [pp, sp, rq, { data: subs }, { data: plans }] = await Promise.all([
    all((a, b) => db.from("pro_payments").select("id, tg_id, payer_id, plan, stars, days, bonus_days, charge_id, until_after, refunded_at, created_at").order("created_at", { ascending: false }).range(a, b), 20000),
    all((a, b) => db.from("shop_owned").select("id, tg_id, payer_id, kind, item, stars, charge_id, refunded_at, created_at").order("created_at", { ascending: false }).range(a, b), 20000),
    all((a, b) => db.from("refund_requests").select("id, tg_id, charge_id, src, reason, note, status, flags, created_at, decided_at").order("created_at", { ascending: false }).range(a, b), 20000),
    db.from("pro_subs").select("tg_id, until").gt("until", new Date(Date.now() - 60 * DAY).toISOString()),
    db.from("pro_plans").select("plan, title, stars, days").order("sort"),
  ]);
  const items = [...pp.map((x: any) => ({ ...x, src: "pro" })), ...sp.map((x: any) => ({ ...x, src: "shop" }))]
    .sort((a: any, b: any) => (a.created_at < b.created_at ? 1 : -1));
  const um = await userMap([...items.flatMap((x: any) => [x.tg_id, x.payer_id]), ...rq.map((x: any) => x.tg_id), ...(subs ?? []).map((x: any) => x.tg_id)]);
  const users: Record<string, any> = {};
  for (const [k, v] of um) users[k] = v;
  return { items, reqs: rq, users, subs: Object.fromEntries((subs ?? []).map((x: any) => [x.tg_id, x.until])), plans: plans ?? [], window_h: REFUND_WINDOW_H, now: Date.now() };
}

async function refund(body: any) {
  const charge = String(body?.charge ?? "");
  const keepPro = !!body?.keep_pro, tell = body?.notify !== false;
  if (!charge) return { error: "Не указан платёж" };
  const [{ data: so }, { data: p }] = await Promise.all([
    db.from("shop_owned").select("*").eq("charge_id", charge).maybeSingle(),
    db.from("pro_payments").select("*").eq("charge_id", charge).maybeSingle(),
  ]);
  const rec: any = so ?? p, src = so ? "shop" : "pro";
  if (!rec) return { error: "Платёж не найден" };
  if (rec.refunded_at) return { error: "Уже возвращён" };
  const payer = Number(rec.payer_id ?? rec.tg_id);
  const r = await tg("refundStarPayment", { user_id: payer, telegram_payment_charge_id: charge });
  // Telegram мог вернуть эти звёзды раньше (вручную) — тогда просто выравниваем базу
  if (!r?.ok && !String(r?.description ?? "").includes("CHARGE_ALREADY_REFUNDED")) return { error: "Telegram: " + (r?.description ?? "ошибка") };
  const nowIso = new Date().toISOString();
  await db.from(src === "shop" ? "shop_owned" : "pro_payments").update({ refunded_at: nowIso }).eq("id", rec.id);
  let cut = 0;
  if (src === "pro" && !keepPro) {
    const { data: s } = await db.from("pro_subs").select("until").eq("tg_id", rec.tg_id).maybeSingle();
    cut = (rec.days ?? 0) + (rec.bonus_days ?? 0);
    if (s?.until) await db.from("pro_subs").update({ until: new Date(new Date(s.until).getTime() - cut * DAY).toISOString(), updated_at: nowIso }).eq("tg_id", rec.tg_id);
  }
  await db.from("refund_requests").update({ status: "approved", decided_at: nowIso }).eq("charge_id", charge).eq("status", "pending");
  if (tell) {
    const what = src === "pro" ? "VOOB PRO" : rec.kind === "frame" ? "рамку" : rec.kind === "kit" ? "комплект" : "фон";
    await say(payer, `↩️ Возврат ${rec.stars}⭐ за ${what} оформлен. Звёзды вернутся на баланс Telegram.`);
    if (src === "shop" && rec.payer_id && rec.payer_id !== rec.tg_id) await say(rec.tg_id, `Подарок (${what}) отозван: платёж был возвращён.`);
  }
  await log("refund", rec.tg_id, { charge, src, stars: rec.stars, keep_pro: keepPro, cut_days: cut, notified: tell });
  return { status: "ok" };
}

// отклонить заявку на возврат; text — своё сообщение покупателю (пусто — стандартное)
async function refundReject(body: any) {
  const id = Number(body?.id);
  const { data: r } = await db.from("refund_requests").select("*").eq("id", id).maybeSingle();
  if (!r) return { error: "Заявка не найдена" };
  if (r.status !== "pending") return { error: "Заявка уже обработана" };
  await db.from("refund_requests").update({ status: "rejected", decided_at: new Date().toISOString() }).eq("id", id);
  const t = String(body?.text ?? "").trim().slice(0, 600);
  if (body?.notify !== false) await say(r.tg_id, t ? `Заявку на возврат отклонили.\n\n${t}` : "Заявку на возврат отклонили. Если это ошибка, напиши в «Идеи и жалобы».");
  await log("refund_reject", r.tg_id, { id, charge: r.charge_id, text: t || null });
  return { status: "ok" };
}

async function broadcast(body: any) {
  const img = typeof body?.image === "string" && body.image.length ? body.image : "";
  const text = String(body?.text ?? "").trim().slice(0, img ? 1000 : 3500);
  if (text.length < 2 && !img) return { error: "Пустое сообщение" };
  let bytes: Uint8Array | null = null;
  if (img) {
    const m = img.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!m || img.length > 7_000_000) return { error: "Картинка не подошла: нужен JPEG, PNG или WebP до 5 МБ" };
    try { bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)); } catch { return { error: "Картинка повреждена" }; }
    if (bytes.length > 5_000_000) return { error: "Картинка больше 5 МБ" };
  }
  // своя кнопка под сообщением (необязательно): заменяет «Открыть VOOB»
  let markup: unknown = openBtn;
  const btnText = String(body?.btn_text ?? "").trim(), btnUrl = String(body?.btn_url ?? "").trim();
  if (btnText || btnUrl) {
    if (!btnText || !btnUrl) return { error: "Для кнопки нужны и название, и ссылка" };
    if ([...btnText].length > 40) return { error: "Название кнопки не длиннее 40 знаков" };
    let u: URL;
    try { u = new URL(btnUrl); } catch { return { error: "Ссылка кнопки не похожа на ссылку" }; }
    if (u.protocol !== "https:") return { error: "Ссылка кнопки должна начинаться с https://" };
    markup = { inline_keyboard: [[{ text: btnText, url: u.toString() }]] };
  }
  const target = String(body?.target ?? "all");
  let ids: number[] = [];
  if (target === "me") ids = [ADMIN];
  else if (target === "pro") { const { data } = await db.from("pro_subs").select("tg_id").gt("until", new Date().toISOString()); ids = (data ?? []).map((x: any) => x.tg_id); }
  else if (target === "free") {
    const { data: pr } = await db.from("pro_subs").select("tg_id").gt("until", new Date().toISOString());
    const pro = new Set((pr ?? []).map((x: any) => Number(x.tg_id)));
    const { data } = await db.from("users").select("tg_id").eq("blocked", false).limit(5000);
    ids = (data ?? []).map((x: any) => Number(x.tg_id)).filter((i) => !pro.has(i) && i !== ADMIN);
  }
  else {
    let r = db.from("users").select("tg_id").eq("blocked", false);
    if (target === "active7") r = r.gte("last_seen", new Date(Date.now() - 7 * DAY).toISOString());
    const { data } = await r.limit(5000);
    ids = (data ?? []).map((x: any) => x.tg_id);
  }
  let fileId = "";
  const sendImg = async (to: number): Promise<boolean> => {
    if (fileId) { const r = await tg("sendPhoto", { chat_id: to, photo: fileId, caption: text || undefined, reply_markup: markup }); return !!r?.ok; }
    const fd = new FormData();
    fd.append("chat_id", String(to)); if (text) fd.append("caption", text);
    fd.append("reply_markup", JSON.stringify(markup));
    fd.append("photo", new Blob([bytes!], { type: "image/jpeg" }), "voob.jpg");
    try {
      const r = await (await fetch(`https://api.telegram.org/bot${BOT}/sendPhoto`, { method: "POST", body: fd })).json();
      if (r?.ok) { const ph = r.result?.photo ?? []; fileId = ph[ph.length - 1]?.file_id ?? ""; return true; }
    } catch { /* ниже посчитаем как неудачу */ }
    return false;
  };
  let sent = 0, failed = 0;
  for (const id of ids) {
    const ok = bytes ? await sendImg(id) : !!(await say(id, text, markup))?.ok;
    if (ok) sent++; else failed++;
    await new Promise((res) => setTimeout(res, 40));
  }
  await log("broadcast", null, { target, sent, failed, text: text.slice(0, 200), image: !!bytes, btn: btnText ? { text: btnText, url: btnUrl } : null });
  return { status: "ok", sent, failed, total: ids.length };
}

Deno.serve(async (req) => {
  const CORS = corsFor(req);
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ app: "VOOB CORE", ok: true });
  try {
    const body = await req.json().catch(() => ({}));
    const a = String(body?.action ?? "");
    // вход в WEB: без сессии, только QR через Telegram
    if (a === "core_login_start") return json(await coreLoginStart());
    if (a === "core_login_poll") return json(await coreLoginPoll(body));
    const tok = body?.token;
    if (typeof tok !== "string" || tok.length < 20) return json({ error: "Нет сессии" }, 401);
    const th = await sha256(tok);
    const { data: s } = await db.from("sessions").select("tg_id, device, created_at, last_seen").eq("token_hash", th).maybeSingle();
    if (!s) return json({ error: "Сессия недействительна — войди заново" }, 401);
    if (Number(s.tg_id) !== ADMIN) return json({ error: "Доступ только для создателя VOOB" }, 403);
    const isCore = s.device === "core";
    const id = Number(body?.tg_id ?? 0), n = body?.notify !== false;
    if (isCore) {
      const born = Date.parse(s.created_at), seen = Date.parse(s.last_seen ?? s.created_at) || born;
      if (Date.now() - born > CORE_MAX || Date.now() - seen > CORE_IDLE) {
        await db.from("sessions").delete().eq("token_hash", th);
        return json({ error: "Сессия истекла — войди заново", expired: true }, 401);
      }
      await db.from("sessions").update({ last_seen: new Date().toISOString() }).eq("token_hash", th);
      if (a === "logout") { await db.from("sessions").delete().eq("token_hash", th); return json({ status: "ok" }); }
      if (a === "whoami") {
        const c = await applyPending();
        return json({ status: "ok", tg_id: ADMIN, core: true, verified: await coreVerified(th), fresh: await coreFresh(th),
          email: c?.email ? maskMail(c.email) : null,
          pending: c?.pending_email ? { email: maskMail(c.pending_email), apply_at: c.pending_apply_at } : null,
          expires_at: new Date(Math.min(born + CORE_MAX, Date.now() + CORE_IDLE)).toISOString() });
      }
      const purpose = body?.purpose === "step" ? "step" : "login";
      if (a === "mail_start") return json(await mailStart(th, purpose));
      if (a === "mail_verify") return json(await mailVerify(th, purpose, body?.code));
      if (a === "otp_start" || a === "otp_verify") return json({ error: "Для WEB используется код с почты" }, 400);
      if (!(await coreVerified(th))) return json({ error: "Подтверди вход кодом с почты", need_otp: true }, 401);
      if (SENS.has(a) && !(await coreFresh(th))) return json({ error: "Подтверди действие кодом с почты", need_step: true }, 401);
      if (a === "sess_list") {
        const { data } = await db.from("sessions").select("token_hash, created_at, last_seen").eq("tg_id", ADMIN).eq("device", "core").order("last_seen", { ascending: false }).limit(20);
        return json({ status: "ok", items: (data ?? []).map((x: any) => ({ id: String(x.token_hash).slice(0, 12), created_at: x.created_at, last_seen: x.last_seen, current: x.token_hash === th })) });
      }
      if (a === "sess_end") {
        const sid = String(body?.id ?? "");
        if (!/^[0-9a-f]{12}$/.test(sid)) return json({ error: "Неверная сессия" });
        const { data: rows } = await db.from("sessions").select("token_hash").eq("tg_id", ADMIN).eq("device", "core").like("token_hash", sid + "%");
        const del = (rows ?? []).filter((x: any) => x.token_hash !== th).map((x: any) => x.token_hash);
        if (!del.length) return json({ error: "Эту сессию завершить нельзя" });
        await db.from("sessions").delete().in("token_hash", del);
        await log("core_sess_end", null, { n: del.length });
        return json({ status: "ok" });
      }
      if (a === "chg_start") return json(await chgStart(th, body?.email));
      if (a === "chg_confirm") return json(await chgConfirm(th, body?.code_new, body?.code_tg));
      if (a === "chg_cancel") return json(await chgCancel());
    } else {
      if (!LEGACY_OK) return json({ error: "Вход из программы отключён — используй core.voob.kz" }, 403);
      if (a === "whoami") return json({ status: "ok", tg_id: ADMIN, verified: await verified(th) });
      if (a === "otp_start") return json(await otpStart(String(body?.purpose ?? "login")));
      if (a === "otp_verify") return json(await otpVerify(th, body?.code, String(body?.purpose ?? "login")));
      if (!(await verified(th))) return json({ error: "Подтверди вход кодом из Telegram", need_otp: true }, 401);
    }
    switch (a) {
      case "photo": return json(await photoB64(id, !!body?.big, !!body?.max));
      case "overview": return json(await overview(body));
      case "events": return json(await events(body));
      case "kick": return json(await kick(id));
      case "users": return json(await users(body));
      case "user": return json(await user(id));
      case "note_set": return json(await noteSet(id, body));
      case "block": return json(await block(id, true, String(body?.reason ?? ""), n));
      case "unblock": return json(await block(id, false, "", n));
      case "gift": return json(await gift(id, String(body?.kind ?? ""), n));
      case "pro": return json(await grantPro(id, Number(body?.days ?? 0), n));
      case "edit": return json(await edit(id, String(body?.field ?? ""), body?.value));
      case "del_workout": return json(await delWorkout(id, String(body?.rid ?? "")));
      case "message": { const r = await say(id, String(body?.text ?? "").slice(0, 3500)); await log("message", id, { text: String(body?.text ?? "").slice(0, 200) }); return json({ status: r?.ok ? "ok" : "fail" }); }
      case "feedback": return json(await feedback(body));
      case "fb_status": { await db.from("feedback").update({ status: String(body?.status ?? "done") }).eq("id", Number(body?.id)); await log("fb_status", null, { id: body?.id, status: body?.status }); return json({ status: "ok" }); }
      case "fb_reply": {
        const { data: f } = await db.from("feedback").select("from_id").eq("id", Number(body?.id)).maybeSingle();
        if (!f) return json({ error: "Нет такого обращения" });
        const text = String(body?.text ?? "").trim().slice(0, 3000);
        const r = await say(f.from_id, `💬 Ответ от команды VOOB:\n\n${text}`);
        await db.from("feedback").update({ reply: text, replied_at: new Date().toISOString(), status: "done" }).eq("id", Number(body?.id));
        await log("fb_reply", f.from_id, { id: body?.id });
        return json({ status: r?.ok ? "ok" : "undelivered" });
      }
      case "payments": return json(await payments(body));
      case "refund": return json(await refund(body));
      case "refund_reject": return json(await refundReject(body));
      case "broadcast": return json(await broadcast(body));
      case "log": { const { data } = await db.from("admin_log").select("id, at, action, target, details").order("id", { ascending: false }).limit(300); return json({ items: (data ?? []).map((x: any) => x.action === "login" ? { ...x, details: {} } : x) }); }
      case "gift_types": { const { data } = await db.from("gift_types").select("kind, emoji, title").order("sort"); return json({ items: data ?? [] }); }
    }
    return json({ error: "Неизвестное действие" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "Внутренняя ошибка сервера" }, 500);
  }
});
