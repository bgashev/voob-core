// VOOB v1.607 — «extra»: объявления (подарки всем, уведомления, акции), отзыв достижений, фоны профиля, статистика платформ.
// Пользователь: inbox / seen / bgs. Создатель (как в voob-core: сессия + вход по коду за 30 дней): announce, announces, ach, user_extra, usage.
// v1.606: создатель может работать и из WEB-версии Core (сессия device="core": вход по почте, простой 30 минут, максимум 8 часов, опасные действия — со свежим кодом).
// v1.607: у объявления может быть картинка (хранится в публичном бакете announce, ссылка в announcements.image_url; в Telegram уходит фото).
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
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
const enc = new TextEncoder();
const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))].map((x) => x.toString(16).padStart(2, "0")).join("");
const DAY = 86400000;
const ACH_KEYS = ["first", "ten", "hundred", "km50", "marathon", "km500", "hours10", "kcal10k", "goat", "long", "streak7", "norm", "norm30", "early", "weigh10", "wgoal", "plan", "friends3", "friends5", "str10", "reps1k", "tonne", "pro", "friends10"];
// v1.539: 56 парных фонов (ключ = ключ PRO-рамки) + старые ключи (клиент сопоставляет их с новыми) — проверяем только формат ключа
const BG_RE = /^[a-z0-9]{3,16}$/;
const openBtn = { inline_keyboard: [[{ text: "Открыть VOOB", web_app: { url: "https://bgashev.github.io/STEPS/" } }]] };
async function say(to: number, text: string) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: to, text, reply_markup: openBtn }) });
    return (await r.json())?.ok === true;
  } catch { return false; }
}
// фото по ссылке: подпись до 1024 знаков (если текст длиннее — сначала фото, потом текст отдельно)
async function sayPhoto(to: number, photo: string, text: string) {
  const fits = text.length <= 1000;
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT}/sendPhoto`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fits ? { chat_id: to, photo, caption: text, reply_markup: openBtn } : { chat_id: to, photo }) });
    if ((await r.json())?.ok !== true) return false;
  } catch { return false; }
  return fits ? true : await say(to, text);
}
const log = (action: string, target: number | null, details: unknown = null) => db.from("admin_log").insert({ action, target, details });
const proOn = (until: string | null | undefined) => !!until && Date.parse(until) > Date.now();

async function proIds(): Promise<Set<number>> {
  const { data } = await db.from("pro_subs").select("tg_id").gt("until", new Date().toISOString());
  return new Set((data ?? []).map((x: any) => Number(x.tg_id)));
}

// ---------- пользователь
async function inbox(me: number) {
  const [{ data: rows }, { data: u }, { data: sub }] = await Promise.all([
    db.from("announce_inbox").select("ann_id, gift_id").eq("tg_id", me).is("seen_at", null).order("ann_id").limit(5),
    db.from("users").select("ach_off").eq("tg_id", me).maybeSingle(),
    db.from("pro_subs").select("until, plan").eq("tg_id", me).maybeSingle(),
  ]);
  const ids = (rows ?? []).map((r: any) => r.ann_id);
  const { data: anns } = ids.length ? await db.from("announcements").select("id, kind, title, body, gift_kind, cta, image_url, created_at").in("id", ids) : { data: [] };
  const gm = new Map((rows ?? []).map((r: any) => [r.ann_id, r.gift_id]));
  const notices = (anns ?? []).sort((a: any, b: any) => a.id - b.id).map((a: any) => ({ ...a, gift_id: gm.get(a.id) ?? null }));
  const pro = me === ADMIN || proOn(sub?.until);
  return { status: "ok", notices, ach_off: (u as any)?.ach_off ?? [], pro, pro_until: sub?.until ?? null, creator: me === ADMIN };
}

/* ответ на опрос: текст уходит в «Жалобы и идеи» (feedback, type = poll); один ответ на человека */
async function pollAnswer(me: number, id: number, textRaw: string) {
  const text = String(textRaw ?? "").trim().slice(0, 1000);
  if (text.length < 2) return { status: "short" };
  const { data: a } = await db.from("announcements").select("kind, title").eq("id", id).maybeSingle();
  if (!a || (a as any).kind !== "poll") return { error: "Это не опрос" };
  const now = new Date().toISOString();
  const { data: ok } = await db.from("announce_inbox").update({ seen_at: now, action: "answer", acted_at: now }).eq("tg_id", me).eq("ann_id", id).is("action", null).select("ann_id");
  if (!ok?.length) return { status: "done" };
  const q = String((a as any).title ?? "");
  const { error } = await db.from("feedback").insert({ from_id: me, type: "poll", target_id: null, text, app: ("Опрос: " + q).slice(0, 120) });
  if (error) { await db.from("announce_inbox").update({ action: null, acted_at: null }).eq("tg_id", me).eq("ann_id", id); return { error: "Не получилось сохранить" }; }
  const { data: u } = await db.from("users").select("first_name, handle").eq("tg_id", me).maybeSingle();
  say(ADMIN, `📊 Ответ на опрос «${q}»\nОт: ${(u as any)?.first_name ?? "?"}${(u as any)?.handle ? " @" + (u as any).handle : ""} (id ${me})\n\n${text}`).catch(() => {});
  return { status: "ok" };
}

async function seen(me: number, id: number, act?: string) {
  const now = new Date().toISOString();
  await db.from("announce_inbox").update({ seen_at: now }).eq("tg_id", me).eq("ann_id", id).is("seen_at", null);   // первый просмотр не затираем
  if (act === "click" || act === "dismiss" || act === "ack") await db.from("announce_inbox").update({ action: act, acted_at: now }).eq("tg_id", me).eq("ann_id", id).is("action", null);
  return { status: "ok" };
}
/* статистика одного объявления: воронка и список людей */
async function annStats(id: number) {
  if (!(id > 0)) return { error: "Нет такого объявления" };
  const { data: rows } = await db.from("announce_inbox").select("tg_id, seen_at, action, acted_at").eq("ann_id", id).limit(5000);
  const all = rows ?? [];
  const count = (f: (r: any) => boolean) => all.filter(f).length;
  const shown = all.filter((r: any) => r.seen_at).sort((a: any, b: any) => (a.seen_at < b.seen_at ? 1 : -1)).slice(0, 300);
  const ids = shown.map((r: any) => Number(r.tg_id));
  const { data: us } = ids.length ? await db.from("users").select("tg_id, first_name, handle").in("tg_id", ids) : { data: [] };
  const um = new Map((us ?? []).map((u: any) => [Number(u.tg_id), u]));
  return {
    status: "ok", total: all.length, seen: count((r) => !!r.seen_at), click: count((r) => r.action === "click"), dismiss: count((r) => r.action === "dismiss"), ack: count((r) => r.action === "ack"), answer: count((r) => r.action === "answer"),
    people: shown.map((r: any) => ({ tg_id: Number(r.tg_id), first_name: (um.get(Number(r.tg_id)) as any)?.first_name ?? null, handle: (um.get(Number(r.tg_id)) as any)?.handle ?? null, seen_at: r.seen_at, action: r.action ?? null, acted_at: r.acted_at ?? null })),
  };
}

// фон карточки профиля: виден только у PRO (и у создателя)
async function bgs(ids: number[]) {
  ids = [...new Set(ids.map(Number).filter((x) => x > 0))].slice(0, 300);
  if (!ids.length) return { bgs: {} };
  const [pro, { data: st }] = await Promise.all([
    proIds(),
    db.from("records").select("tg_id, data, deleted").eq("kind", "meta").eq("id", "settings").in("tg_id", ids),
  ]);
  const out: Record<string, string> = {};
  for (const r of st ?? []) {
    const id = Number((r as any).tg_id), b = (r as any).deleted ? null : (r as any).data?.bg;
    if (typeof b === "string" && BG_RE.test(b) && (pro.has(id) || id === ADMIN)) out[id] = b;
  }
  return { bgs: out };
}

// ---------- промокоды (v1.545: рамки и фоны — только PRO, отдельного промокода на рамку нет)
const normCode = (c: unknown) => String(c ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const ALPH = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";                       // без 0/O и 1/I/L — не спутать
function genCode() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  const s = [...b].map((x) => ALPH[x % ALPH.length]).join("");
  return `VOOB-${s.slice(0, 4)}-${s.slice(4)}`;
}
async function grantProDays(id: number, days: number) {
  const { data: cur } = await db.from("pro_subs").select("until").eq("tg_id", id).maybeSingle();
  const base = cur?.until && Date.parse(cur.until) > Date.now() ? Date.parse(cur.until) : Date.now();
  const until = new Date(base + days * DAY).toISOString();
  const { error } = await db.from("pro_subs").upsert({ tg_id: id, until, plan: "promo", updated_at: new Date().toISOString() }, { onConflict: "tg_id" });
  return error ? null : until;
}
async function redeem(me: number, raw: unknown) {
  const n = normCode(raw);
  if (n.length < 6) return { status: "bad" };
  const { count } = await db.from("promo_fails").select("id", { count: "exact", head: true }).eq("tg_id", me).gte("at", new Date(Date.now() - 3600000).toISOString());
  if ((count ?? 0) >= 8) return { status: "limit" };
  const code = n.startsWith("VOOB") && n.length === 12 ? `VOOB-${n.slice(4, 8)}-${n.slice(8)}` : String(raw ?? "").trim().toUpperCase();
  const { data: pc } = await db.from("promo_codes").select("kind, value").eq("code", code).maybeSingle();
  // коды старого типа «рамка» больше не действуют — не списываем использование
  const st = pc && (pc.kind === "pro" || pc.kind === "gift") ? (await db.rpc("promo_take", { p_code: code, p_tg: me })).data : "bad";
  if (st !== "ok") {
    if (st === "bad") await db.from("promo_fails").insert({ tg_id: me });
    return { status: st ?? "bad" };
  }
  const k = pc!.kind, v = pc!.value;
  if (k === "pro") {
    const until = await grantProDays(me, Math.max(1, Math.min(3650, Number(v) || 0)));
    await log("promo", me, { code, kind: k, value: v });
    return { status: "ok", kind: k, value: v, until };
  }
  if (k === "gift") {
    await db.from("gifts").insert({ from_id: ADMIN, to_id: me, kind: v, claimed_at: new Date().toISOString() });
  }
  await log("promo", me, { code, kind: k, value: v });
  return { status: "ok", kind: k, value: v };
}
async function promoCreate(b: any) {
  const kind = String(b?.kind ?? "");
  let value = String(b?.value ?? "");
  if (kind === "pro") { const d = Math.round(Number(value)); if (!(d >= 1 && d <= 3650)) return { error: "PRO: от 1 до 3650 дней" }; value = String(d); }
  else if (kind === "gift") { const { data: gt } = await db.from("gift_types").select("kind").eq("kind", value).maybeSingle(); if (!gt || value === "pro") return { error: "Неизвестный подарок" }; }
  else return { error: "Неизвестный тип" };
  const count = Math.max(1, Math.min(5000, Math.round(Number(b?.count) || 1)));
  const uses = Math.max(1, Math.min(100000, Math.round(Number(b?.uses) || 1)));
  const days = Math.round(Number(b?.expires_days) || 0);
  const expires_at = days > 0 ? new Date(Date.now() + days * DAY).toISOString() : null;
  const custom = count === 1 && b?.custom ? String(b.custom).trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 24) : "";
  if (custom && custom.length < 4) return { error: "Свой код — от 4 символов" };
  const batch = `${new Date().toISOString().slice(0, 16)}·${Math.random().toString(36).slice(2, 6)}`;
  const rows = [];
  const seenC = new Set<string>();
  while (rows.length < count) { const c = custom || genCode(); if (seenC.has(c)) continue; seenC.add(c);
    rows.push({ code: c, kind, value, max_uses: uses, batch, note: String(b?.note ?? "").slice(0, 120) || null, expires_at }); }
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("promo_codes").insert(rows.slice(i, i + 500));
    if (error) return { error: error.code === "23505" ? "Такой код уже есть" : error.message };
  }
  await log("promo_create", null, { kind, value, count, uses, batch });
  return { status: "ok", codes: rows.map((r) => r.code), batch };
}
async function promoList() {
  const { data } = await db.from("promo_codes").select("*").order("created_at", { ascending: false }).limit(1000);
  return { items: data ?? [] };
}

// ---------- создатель
async function verified(th: string) {
  const { data } = await db.from("admin_log").select("id").eq("action", "login").eq("details->>th", th)
    .gte("at", new Date(Date.now() - 30 * DAY).toISOString()).limit(1);
  return !!data?.length;
}

// «Список»: ники VOOB (@one), username Telegram или ID — через запятую, пробел или с новой строки
async function resolveList(raw: unknown) {
  const toks = [...new Set((Array.isArray(raw) ? raw.join(" ") : String(raw ?? "")).split(/[\s,;]+/)
    .map((t) => t.trim().replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "")).filter(Boolean))].slice(0, 500);
  const nums = toks.filter((t) => /^\d{3,15}$/.test(t)).map(Number);
  const names = toks.filter((t) => !/^\d+$/.test(t) && /^[A-Za-z0-9_.]{2,32}$/.test(t)).map((t) => t.toLowerCase());
  const found = new Map<string, { tg_id: number; name: string }>();
  const take = (rows: any[] | null) => { for (const u of rows ?? []) {
    const nm = u.first_name || u.handle || u.username || String(u.tg_id);
    for (const k of [String(u.tg_id), (u.handle ?? "").toLowerCase(), (u.username ?? "").toLowerCase()]) if (k) found.set(k, { tg_id: Number(u.tg_id), name: nm });
  } };
  const sel = "tg_id, first_name, handle, username, blocked";
  if (nums.length) take((await db.from("users").select(sel).in("tg_id", nums)).data);
  if (names.length) {
    take((await db.from("users").select(sel).in("handle", names)).data);
    take((await db.from("users").select(sel).in("username", names)).data);
    const rest = names.filter((n) => !found.has(n));                  // ники с заглавными буквами — по одному, без учёта регистра
    for (const n of rest.slice(0, 60)) take((await db.from("users").select(sel).or(`handle.ilike.${n},username.ilike.${n}`).limit(1)).data);
  }
  const ok: { q: string; tg_id: number; name: string }[] = [], miss: string[] = [];
  for (const t of toks) { const f = found.get(/^\d+$/.test(t) ? t : t.toLowerCase()); if (f) ok.push({ q: t, ...f }); else miss.push(t); }
  const ids = [...new Set(ok.map((x) => x.tg_id))];
  return { ids, ok, miss };
}

/* группы получателей по времени и активности (одинаково в рассылке и в объявлениях) */
const SEG_NEW: Record<string, number> = { new1: DAY, new7: 7 * DAY, new30: 30 * DAY, new365: 365 * DAY };
const SEG_ACT: Record<string, number> = { act1: DAY, act7: 7 * DAY };
const SEG_KEYS = [...Object.keys(SEG_NEW), ...Object.keys(SEG_ACT), "often", "expired"];
const OFTEN_DAYS = 14, OFTEN_MIN = 3;   // «частые гости»: записи в приложении минимум в 3 разных дня за последние 14
async function segIds(aud: string): Promise<number[] | null> {
  if (!SEG_KEYS.includes(aud)) return null;
  const iso = (ms: number) => new Date(Date.now() - ms).toISOString();
  const ids = (d: any[] | null) => (d ?? []).map((x: any) => Number(x.tg_id));
  if (SEG_NEW[aud]) return ids((await db.from("users").select("tg_id").eq("blocked", false).gte("created_at", iso(SEG_NEW[aud])).limit(20000)).data);
  if (SEG_ACT[aud]) return ids((await db.from("users").select("tg_id").eq("blocked", false).gte("last_seen", iso(SEG_ACT[aud])).limit(20000)).data);
  const ok = new Set(ids((await db.from("users").select("tg_id").eq("blocked", false).limit(20000)).data));
  if (aud === "expired") return ids((await db.from("pro_subs").select("tg_id").lte("until", new Date().toISOString()).limit(20000)).data).filter((i) => ok.has(i));
  const since = Date.now() - OFTEN_DAYS * DAY, byUser = new Map<number, Set<number>>();
  for (let from = 0; from < 100000; from += 5000) {
    const { data } = await db.from("records").select("tg_id, updated").eq("deleted", false).gt("updated", since).order("rev").range(from, from + 4999);
    for (const r of data ?? []) { const t = Number((r as any).tg_id); (byUser.get(t) ?? byUser.set(t, new Set()).get(t)!).add(Math.floor((Number((r as any).updated) + 5 * 3600e3) / DAY)); }
    if ((data?.length ?? 0) < 5000) break;
  }
  return [...byUser].filter(([t, d]) => d.size >= OFTEN_MIN && ok.has(t)).map(([t]) => t);
}

async function audienceIds(aud: string, list?: unknown): Promise<number[]> {
  if (aud === "me") return [ADMIN];
  if (aud === "list") return (await resolveList(list)).ids;
  const sg = await segIds(aud);
  if (sg) return sg;
  const { data } = await db.from("users").select("tg_id").eq("blocked", false).limit(20000);
  const all = (data ?? []).map((x: any) => Number(x.tg_id));
  if (aud === "all") return all;
  const pro = await proIds();
  return aud === "pro" ? all.filter((i) => pro.has(i) || i === ADMIN) : all.filter((i) => !pro.has(i) && i !== ADMIN);
}

// картинка объявления: data URL (JPEG/PNG/WebP до 5 МБ) → публичный бакет announce → ссылка
async function uploadImage(raw: unknown): Promise<{ url?: string; error?: string }> {
  if (typeof raw !== "string" || !raw) return {};
  const m = raw.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m || raw.length > 7_000_000) return { error: "Картинка не подошла: нужен JPEG, PNG или WebP до 5 МБ" };
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)); } catch { return { error: "Картинка повреждена" }; }
  if (bytes.length > 5_000_000) return { error: "Картинка больше 5 МБ" };
  const ext = m[1] === "jpeg" ? "jpg" : m[1];
  const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;
  const { error } = await db.storage.from("announce").upload(path, bytes, { contentType: `image/${m[1]}`, cacheControl: "31536000" });
  if (error) return { error: "Не загрузилась картинка: " + error.message };
  return { url: db.storage.from("announce").getPublicUrl(path).data.publicUrl };
}

async function announce(b: any) {
  const kind = String(b?.kind ?? "");
  const aud = String(b?.audience ?? "all");
  if (!["gift", "notice", "promo", "poll"].includes(kind)) return { error: "Неизвестный тип" };
  if (![...["all", "pro", "free", "me", "list"], ...SEG_KEYS].includes(aud)) return { error: "Неизвестная аудитория" };
  const title = String(b?.title ?? "").trim().slice(0, 80);
  const body = String(b?.body ?? "").trim().slice(0, 600);
  if (title.length < 2) return { error: "Нужен заголовок" };
  let gk: string | null = null;
  if (kind === "gift") {
    gk = String(b?.gift_kind ?? "");
    const { data: gt } = await db.from("gift_types").select("kind").eq("kind", gk).maybeSingle();
    if (!gt || gk === "pro") return { error: "Выбери подарок" };
  }
  const cta0 = b?.cta && kind !== "poll" ? String(b.cta).trim().slice(0, 300) : "";
  // ссылку можно писать без https://: t.me/..., @ник, example.kz/...
  const cta = !cta0 ? null : cta0 === "pro" ? cta0 : /^@\w{4,}$/.test(cta0) ? "https://t.me/" + cta0.slice(1) : /^[a-z][a-z0-9+.-]*:\/\//i.test(cta0) ? cta0 : "https://" + cta0.replace(/^\/+/, "");
  if (cta && cta !== "pro" && !/^https:\/\/\S+$/.test(cta)) return { error: "Кнопка: «pro» или ссылка (например t.me/boost/voobkz)" };
  const ids = await audienceIds(aud, b?.targets);
  if (!ids.length) return { error: aud === "list" ? "В списке никого не нашли — проверь ники и ID" : "В этой аудитории никого нет" };
  if (b?.dry) return { status: "ok", total: ids.length };
  const up = await uploadImage(b?.image);
  if (up.error) return { error: up.error };
  const { data: a, error } = await db.from("announcements").insert({ kind, audience: aud, title, body, gift_kind: gk, cta, image_url: up.url ?? null, recipients: ids.length }).select("id").single();
  if (error || !a) return { error: error?.message ?? "Не удалось создать" };
  // подарок сразу «получен»: он уже в коллекции, а окно объявления — само поздравление (без второго окна «Входящие подарки»)
  let gifts = new Map<number, number>();
  if (gk) {
    for (let i = 0; i < ids.length; i += 500) {
      const { data: gs, error: ge } = await db.from("gifts").insert(ids.slice(i, i + 500).map((to) => ({ from_id: ADMIN, to_id: to, kind: gk, claimed_at: new Date().toISOString() }))).select("id, to_id");
      if (ge) return { error: "Подарки: " + ge.message };
      for (const g of gs ?? []) gifts.set(Number((g as any).to_id), Number((g as any).id));
    }
  }
  for (let i = 0; i < ids.length; i += 500) {
    await db.from("announce_inbox").insert(ids.slice(i, i + 500).map((t) => ({ ann_id: a.id, tg_id: t, gift_id: gifts.get(t) ?? null })));
  }
  let sent = 0;
  if (b?.notify) {
    const head = kind === "gift" ? "🎁 " : kind === "promo" ? "✨ " : kind === "poll" ? "📊 " : "📣 ";
    const text = kind === "poll" ? `${head}${title}${body ? "\n\n" + body : ""}\n\nОтветь в приложении — мы читаем каждый ответ.\n\n— команда VOOB` : `${head}${title}\n\n${body}\n\n— команда VOOB`;
    for (const t of ids) { if (up.url ? await sayPhoto(t, up.url, text) : await say(t, text)) sent++; await new Promise((r) => setTimeout(r, 40)); }
  }
  await log("announce", null, { id: a.id, kind, audience: aud, title, gift: gk, n: ids.length, sent, image: !!up.url });
  return { status: "ok", id: a.id, total: ids.length, sent };
}

async function announces() {
  const { data } = await db.from("announcements").select("*").order("id", { ascending: false }).limit(60);
  const ids = (data ?? []).map((x: any) => x.id);
  const { data: s } = ids.length ? await db.from("announce_inbox").select("ann_id").in("ann_id", ids).not("seen_at", "is", null) : { data: [] };
  const cnt = new Map<number, number>();
  for (const r of s ?? []) cnt.set((r as any).ann_id, (cnt.get((r as any).ann_id) ?? 0) + 1);
  return { items: (data ?? []).map((x: any) => ({ ...x, seen: cnt.get(x.id) ?? 0 })) };
}

async function audienceCounts() {
  const [all, pro] = await Promise.all([audienceIds("all"), proIds()]);
  const p = all.filter((i) => pro.has(i) || i === ADMIN).length;
  const seg: Record<string, number> = {};
  await Promise.all(SEG_KEYS.map(async (k) => { try { seg[k] = ((await segIds(k)) ?? []).length; } catch { seg[k] = 0; } }));
  return { all: all.length, pro: p, free: all.length - p, ...seg };
}

async function ach(id: number, key: string, on: boolean, notify: boolean) {
  if (!ACH_KEYS.includes(key)) return { error: "Неизвестное достижение" };
  const { data: u } = await db.from("users").select("ach_off").eq("tg_id", id).maybeSingle();
  if (!u) return { error: "Нет такого пользователя" };
  const cur: string[] = (u as any).ach_off ?? [];
  const next = on ? cur.filter((x) => x !== key) : [...new Set([...cur, key])];
  const { error } = await db.from("users").update({ ach_off: next }).eq("tg_id", id);
  if (error) return { error: error.message };
  if (notify) await say(id, on ? "🏅 Команда VOOB вернула тебе достижение." : "⚠️ Команда VOOB отозвала одно из твоих достижений: оно получено нечестно или по ошибке.");
  await log(on ? "ach_back" : "ach_off", id, { key });
  return { status: "ok", ach_off: next };
}

// v1.605: статистика по платформам (Mini App / WEB / ПК) за 24 ч / 7 / 30 дней
async function usage(hours: number) {
  const h = [24, 168, 720].includes(hours) ? hours : 168;
  const since = new Date(Date.now() - h * 3600000).toISOString();
  const [{ data: ss }, { data: nu }, { count: wk }, { count: lg }] = await Promise.all([
    db.from("sessions").select("tg_id, device, last_seen").gte("last_seen", since).limit(50000),
    db.from("users").select("tg_id").gte("created_at", since).limit(50000),
    db.from("records").select("tg_id", { count: "exact", head: true }).eq("kind", "workout").eq("deleted", false).gte("updated", since),
    db.from("sessions").select("token_hash", { count: "exact", head: true }).gte("created_at", since),
  ]);
  const P = ["miniapp", "web", "desktop"];
  const plat = (d: string) => (P.includes(d) ? d : "desktop");
  const sets: Record<string, Set<number>> = { miniapp: new Set(), web: new Set(), desktop: new Set() };
  const all = new Set<number>();
  const step = h <= 48 ? "hour" : "day", ms = step === "hour" ? 3600000 : DAY;
  const n = Math.ceil((h * 3600000) / ms), t0 = Math.floor(Date.now() / ms) * ms - (n - 1) * ms;
  const buckets: Record<string, Set<number>>[] = Array.from({ length: n }, () => ({ miniapp: new Set(), web: new Set(), desktop: new Set() }));
  for (const r of ss ?? []) {
    const id = Number((r as any).tg_id), p = plat(String((r as any).device));
    sets[p].add(id); all.add(id);
    const i = Math.floor((Date.parse((r as any).last_seen) - t0) / ms);
    if (i >= 0 && i < n) buckets[i][p].add(id);
  }
  const both = [...sets.miniapp].filter((x) => sets.web.has(x) || sets.desktop.has(x)).length;
  return {
    status: "ok", hours: h, step,
    platforms: { miniapp: { users: sets.miniapp.size }, web: { users: sets.web.size }, desktop: { users: sets.desktop.size } },
    users_total: all.size, new_users: (nu ?? []).length, workouts: wk ?? 0, logins: lg ?? 0, both,
    series: buckets.map((b, i) => ({ t: new Date(t0 + i * ms).toISOString(), miniapp: b.miniapp.size, web: b.web.size, desktop: b.desktop.size })),
  };
}

/* ---------- отложенная отправка объявлений ---------- */
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const safeEq = (a: string, b: string) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
async function schedAddAnn(b: any) {
  const at = Date.parse(String(b?.send_at ?? ""));
  if (!isFinite(at) || at < Date.now() + 60_000) return { error: "Время отправки должно быть хотя бы через минуту" };
  if (at > Date.now() + 60 * DAY) return { error: "Дальше чем на 60 дней планировать нельзя" };
  const v: any = await announce({ ...b, dry: true }); if (v?.error) return v;
  const payload = { ...b }; delete payload.send_at; delete payload.token; delete payload.action; delete payload.client;
  const summary = String(b?.title ?? "").trim().slice(0, 100);
  const { data, error } = await db.from("scheduled_sends").insert({ fn: "announce", payload, run_at: new Date(at).toISOString(), summary }).select("id").single();
  if (error || !data) return { error: "Не удалось запланировать: " + (error?.message ?? "") };
  await log("sched_add", null, { id: data.id, fn: "announce", at: new Date(at).toISOString(), summary: summary.slice(0, 80) });
  return { status: "scheduled", id: data.id, at: new Date(at).toISOString() };
}
async function schedRunAnn() {
  const { data: due } = await db.from("scheduled_sends").update({ status: "running" }).eq("fn", "announce").eq("status", "pending").lte("run_at", new Date().toISOString()).select("id, payload, summary");
  let n = 0;
  for (const r of due ?? []) {
    let res: any; try { res = await announce(r.payload); } catch (x) { res = { error: String((x as Error)?.message ?? x) }; }
    await db.from("scheduled_sends").update({ status: res?.error ? "failed" : "sent", result: res, done_at: new Date().toISOString() }).eq("id", r.id);
    await say(ADMIN, res?.error ? `⚠️ Отложенное объявление не ушло: ${res.error}\n«${r.summary ?? ""}»` : `✅ Отложенное объявление отправлено: ${res.total} получателей\n«${r.summary ?? ""}»`);
    n++;
  }
  return { status: "ok", ran: n };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ app: "VOOB extra", version: "1.607", ok: true });
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.action === "sched_run") { if (!CRON_SECRET || !safeEq(req.headers.get("x-cron-secret") ?? "", CRON_SECRET)) return json({ error: "Нет доступа" }, 403); return json(await schedRunAnn()); }
    const tok = body?.token;
    if (typeof tok !== "string" || tok.length < 20) return json({ error: "Нет сессии" }, 401);
    const th = await sha256(tok);
    const { data: s } = await db.from("sessions").select("tg_id, device, created_at, last_seen").eq("token_hash", th).maybeSingle();
    if (!s) return json({ error: "Сессия недействительна — войди заново" }, 401);
    // v1.605: WEB-версия присылает client:'web' — помечаем её сессию отдельно от программы для Windows
    if (body?.client === "web" && (s as any).device === "desktop") await db.from("sessions").update({ device: "web" }).eq("token_hash", th);
    const me = Number(s.tg_id), a = String(body?.action ?? "");
    if (a === "inbox") return json(await inbox(me));
    if (a === "seen") return json(body?.act === "answer" ? await pollAnswer(me, Number(body?.id), String(body?.text ?? "")) : await seen(me, Number(body?.id), String(body?.act ?? "")));
    if (a === "bgs") return json(await bgs(Array.isArray(body?.ids) ? body.ids : []));
    if (a === "promo") return json(await redeem(me, body?.code));
    // дальше — только создатель с подтверждённым входом
    if (me !== ADMIN) return json({ error: "Доступ только для создателя VOOB" }, 403);
    if ((s as any).device === "core") {
      // WEB Core: те же правила, что в voob-core — простой 30 минут, максимум 8 часов, вход подтверждён почтой, опасное — со свежим кодом
      const born = Date.parse((s as any).created_at), seenAt = Date.parse((s as any).last_seen ?? (s as any).created_at) || born;
      if (Date.now() - born > 8 * 3600000 || Date.now() - seenAt > 30 * 60000) {
        await db.from("sessions").delete().eq("token_hash", th);
        return json({ error: "Сессия истекла — войди заново", expired: true }, 401);
      }
      await db.from("sessions").update({ last_seen: new Date().toISOString() }).eq("token_hash", th);
      const { data: okLogin } = await db.from("core_otp").select("id").eq("th", th).eq("purpose", "login").not("used_at", "is", null).limit(1);
      if (!okLogin?.length) return json({ error: "Подтверди вход кодом с почты", need_otp: true }, 401);
      if (["announce", "promo_create", "promo_off", "promo_delete", "ach"].includes(a)) {
        const { data: fresh } = await db.from("core_otp").select("id").eq("th", th).in("purpose", ["login", "step"]).gte("used_at", new Date(Date.now() - 5 * 60000).toISOString()).limit(1);
        if (!fresh?.length) {
          // объявление: себе — без кода; остальным — короткий код (его проверяет voob-core, отметка pin_ok в журнале на 5 минут)
          if (a === "announce") {
            if (String(body?.audience ?? "") !== "me") {
              const { data: pin } = await db.from("admin_log").select("id").eq("action", "pin_ok").eq("details->>th", th).gte("at", new Date(Date.now() - 5 * 60000).toISOString()).limit(1);
              if (!pin?.length) return json({ error: "Введи код подтверждения", need_pin: true }, 401);
            }
          } else return json({ error: "Подтверди действие кодом с почты", need_step: true }, 401);
        }
      }
    } else if (!(await verified(th))) return json({ error: "Подтверди вход кодом из Telegram", need_otp: true }, 401);
    const id = Number(body?.tg_id ?? 0);
    switch (a) {
      case "announce": return json(body?.send_at ? await schedAddAnn(body) : await announce(body));
      case "announces": return json(await announces());
      case "ann_stats": return json(await annStats(Number(body?.id)));
      case "audience": return json(await audienceCounts());
      case "resolve": return json(await resolveList(body?.targets));
      case "usage": return json(await usage(Number(body?.hours)));
      case "promo_create": return json(await promoCreate(body));
      case "promo_list": return json(await promoList());
      case "promo_delete": {
        const codes = (Array.isArray(body?.codes) ? body.codes : [body?.code]).map((x: unknown) => String(x ?? "")).filter(Boolean).slice(0, 200);
        if (!codes.length) return json({ error: "Не выбран код" });
        const { data: del, error } = await db.from("promo_codes").delete().in("code", codes).select("code, kind, value");
        if (error) return json({ error: error.message });
        await log("promo_delete", null, { codes: (del ?? []).map((x: any) => x.code) });
        return json({ status: "ok", deleted: del?.length ?? 0 }); }
      case "promo_off": { await db.from("promo_codes").update({ active: body?.on === true }).in("code", (Array.isArray(body?.codes) ? body.codes : [body?.code]).map(String));
        await log("promo_off", null, { codes: body?.codes ?? body?.code, on: body?.on === true }); return json({ status: "ok" }); }
      case "ach": return json(await ach(id, String(body?.key ?? ""), body?.on === true, body?.notify !== false));
      case "user_extra": { const { data: u } = await db.from("users").select("ach_off").eq("tg_id", id).maybeSingle(); return json({ ach_off: (u as any)?.ach_off ?? [] }); }
    }
    return json({ error: "Неизвестное действие" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "Внутренняя ошибка сервера" }, 500);
  }
});
