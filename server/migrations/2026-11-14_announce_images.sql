alter table public.announcements add column if not exists image_url text;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('announce', 'announce', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true, file_size_limit = 5242880, allowed_mime_types = array['image/jpeg','image/png','image/webp'];
