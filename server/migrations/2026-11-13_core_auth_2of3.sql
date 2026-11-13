-- VOOB CORE: вход «любые 2 из 3» (Telegram, почта+пароль, код с почты) + резервные коды.
-- Применять только после явного «Деплой».
CREATE TABLE IF NOT EXISTS public.core_flow (
  fh text PRIMARY KEY,                       -- sha256 одноразового токена попытки входа
  factors text[] NOT NULL DEFAULT '{}',      -- какие способы уже пройдены: tg, pwd, mail, backup
  tg_code text,                              -- код QR, привязанный к этой попытке
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.core_backup (
  id bigserial PRIMARY KEY,
  code_hash text NOT NULL UNIQUE,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.core_flow ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.core_backup ENABLE ROW LEVEL SECURITY;
-- политик нет: доступ только у серверного ключа Edge Functions
