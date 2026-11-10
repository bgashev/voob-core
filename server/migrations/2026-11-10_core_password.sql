-- VOOB CORE: вход по паролю (необязательный). Хранится только PBKDF2-хеш с солью.
ALTER TABLE public.core_config
  ADD COLUMN IF NOT EXISTS pwd_hash text,
  ADD COLUMN IF NOT EXISTS pwd_salt text,
  ADD COLUMN IF NOT EXISTS pwd_updated_at timestamptz;
