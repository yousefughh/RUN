-- RUNMATE database schema for Supabase
-- You can run this script again safely for the policies and triggers defined below.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  display_name text,
  phone text,
  avatar_path text,
  role text not null default 'member' check (role in ('member', 'admin', 'owner')),
  created_at timestamptz not null default now()
);

create table if not exists public.runs (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  starts_at timestamptz not null,
  location text not null,
  distance_km numeric not null default 5 check (distance_km > 0),
  seats_total integer not null default 15 check (seats_total > 0),
  seats_booked integer not null default 0 check (seats_booked >= 0),
  price text default 'مجانية',
  image_url text,
  admin_only_chat boolean not null default false,
  organizer_name text,
  created_by uuid references auth.users,
  created_at timestamptz not null default now()
);

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references public.runs on delete cascade not null,
  user_id uuid references auth.users on delete cascade not null,
  created_at timestamptz not null default now(),
  unique (run_id, user_id)
);

-- Keep available seats in sync with bookings and reject overbooking.
-- Keep available seats in sync with bookings and reject overbooking.
create OR REPLACE FUNCTION public.sync_run_seats_booked()
returns trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $
begin
  IF TG_OP = 'INSERT' THEN
    update public.runs
    set seats_booked = seats_booked + 1
    where id = NEW.run_id AND seats_booked < seats_total;
    if NOT FOUND THEN RAISE EXCEPTION 'Run is full or has no available seats'; END IF;
    return NEW;
  elsif TG_OP = 'DELETE' THEN
    update public.runs
    set seats_booked = greatest(seats_booked - 1, 0)
    where id = OLD.run_id;
    return OLD;
  end if;
  return NULL;
end;
$;
drop TRIGGER IF EXISTS bookings_sync_run_seats_after_insert ON public.bookings;
drop TRIGGER IF EXISTS bookings_sync_run_seats_after_delete ON public.bookings;
create TRIGGER bookings_sync_run_seats_after_insert
after INSERT ON public.bookings FOR EACH ROW
execute FUNCTION public.sync_run_seats_booked();
create TRIGGER bookings_sync_run_seats_after_delete
after DELETE ON public.bookings FOR EACH ROW
execute FUNCTION public.sync_run_seats_booked();
update public.runs r SET seats_booked = (
  select count(*)::integer FROM public.bookings b WHERE b.run_id = r.id
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references public.runs on delete cascade not null,
  user_id uuid references auth.users on delete cascade not null,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

-- Automatically create a profile even when email confirmation is required.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, phone, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(coalesce(new.email, ''), '@', 1), 'مستخدم RUNMATE'),
    coalesce(new.raw_user_meta_data ->> 'phone', ''),
    'member'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- Prevent regular users from changing their own role to admin.
create or replace function public.protect_profile_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role is distinct from old.role
     and auth.uid() is not null
     and not exists (
       select 1 from public.profiles p
       where p.id = auth.uid() and p.role IN ('admin', 'owner')
     ) then
    raise exception 'Only an administrator or owner can change account roles';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile_role_trigger on public.profiles;
create trigger protect_profile_role_trigger
before update on public.profiles
for each row execute procedure public.protect_profile_role();

create or replace function public.set_profile_role(target_profile_id uuid, requested_role text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('runmate-owner-role-change', 0));
  if auth.uid() is null or not exists (
    select 1 from public.profiles where id = auth.uid() and role = 'owner'
  ) then
    raise exception 'Only an owner can manage account roles';
  end if;
  if requested_role is null or requested_role not in ('member', 'admin', 'owner') then
    raise exception 'Invalid account role';
  end if;
  if target_profile_id = auth.uid() and requested_role <> 'owner' then
    raise exception 'An owner cannot remove their own owner role';
  end if;
  if requested_role <> 'owner'
     and exists (select 1 from public.profiles where id = target_profile_id and role = 'owner')
     and (select count(*) from public.profiles where role = 'owner') <= 1 then
    raise exception 'Cannot remove the last owner';
  end if;
  update public.profiles set role = requested_role where id = target_profile_id;
  if not found then raise exception 'Profile not found'; end if;
end;
$$;
revoke all on function public.set_profile_role(uuid, text) from public, anon;
grant execute on function public.set_profile_role(uuid, text) to authenticated;

alter table public.profiles enable row level security;
alter table public.runs enable row level security;
alter table public.bookings enable row level security;
alter table public.messages enable row level security;

-- Drop policies from earlier versions before recreating them.
drop policy if exists "Public profiles are viewable by everyone." on public.profiles;
drop policy if exists "Users can insert/update their profile." on public.profiles;
drop policy if exists "Users can update own profile." on public.profiles;
drop policy if exists "Runs are viewable by everyone." on public.runs;
drop policy if exists "Admins can insert runs." on public.runs;
drop policy if exists "Admins can update runs." on public.runs;
drop policy if exists "Admins can delete runs." on public.runs;
drop policy if exists "Bookings viewable by owner." on public.bookings;
drop policy if exists "Users can insert bookings." on public.bookings;
drop policy if exists "Users can delete own bookings." on public.bookings;
drop policy if exists "Messages viewable by bookers or admins." on public.messages;
drop policy if exists "Messages insert by authorized users or admins." on public.messages;

create policy "Profiles are viewable by authenticated users"
on public.profiles for select to authenticated using (true);

create policy "Users can insert their own regular profile"
on public.profiles for insert to authenticated
with check (auth.uid() = id and role = 'member');

create policy "Users can update their own profile"
on public.profiles for update to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

create policy "Runs are viewable by everyone"
on public.runs for select using (true);

create policy "Admins can insert runs"
on public.runs for insert to authenticated
with check (exists (select 1 from public.profiles where id = auth.uid() and role IN ('admin', 'owner')));

create policy "Admins can update runs"
on public.runs for update to authenticated
using (exists (select 1 from public.profiles where id = auth.uid() and role IN ('admin', 'owner')))
with check (exists (select 1 from public.profiles where id = auth.uid() and role IN ('admin', 'owner')));

create policy "Admins can delete runs"
on public.runs for delete to authenticated
using (exists (select 1 from public.profiles where id = auth.uid() and role IN ('admin', 'owner')));

create policy "Bookings viewable by owner"
on public.bookings for select to authenticated
using (auth.uid() = user_id or exists (select 1 from public.profiles where id = auth.uid() and role IN ('admin', 'owner')));

create policy "Users can insert bookings"
on public.bookings for insert to authenticated
with check (auth.uid() = user_id);

create policy "Users can delete own bookings"
on public.bookings for delete to authenticated
using (auth.uid() = user_id or exists (select 1 from public.profiles where id = auth.uid() and role IN ('admin', 'owner')));

create policy "Messages viewable by bookers or admins"
on public.messages for select to authenticated
using (
  exists (select 1 from public.bookings where bookings.run_id = messages.run_id and bookings.user_id = auth.uid())
  or exists (select 1 from public.profiles where id = auth.uid() and role IN ('admin', 'owner'))
);

create policy "Messages insert by authorized users or admins"
on public.messages for insert to authenticated
with check (
  auth.uid() = user_id and (
    exists (select 1 from public.bookings where bookings.run_id = messages.run_id and bookings.user_id = auth.uid())
    or exists (select 1 from public.profiles where id = auth.uid() and role IN ('admin', 'owner'))
  ) and (
    not exists (select 1 from public.runs where runs.id = messages.run_id and runs.admin_only_chat = true)
    or exists (select 1 from public.profiles where id = auth.uid() and role IN ('admin', 'owner'))
  )
);
-- RUNMATE compatibility and Clips migration. Safe to re-run; preserves users and existing profiles.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone text;
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.profiles'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE public.profiles DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
UPDATE public.profiles SET role = 'member' WHERE role = 'user';
ALTER TABLE public.profiles ALTER COLUMN role SET DEFAULT 'member';
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check CHECK (role IN ('member', 'admin', 'owner'));

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, phone, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data ->> 'display_name', NULLIF(split_part(COALESCE(NEW.email, ''), '@', 1), ''), 'RUNMATE member'),
    NULLIF(NEW.raw_user_meta_data ->> 'phone', ''),
    'member'
  ) ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
INSERT INTO public.profiles (id, display_name, phone, role)
SELECT u.id, COALESCE(u.raw_user_meta_data ->> 'display_name', NULLIF(split_part(COALESCE(u.email, ''), '@', 1), '')),
       NULLIF(u.raw_user_meta_data ->> 'phone', ''), 'member'
FROM auth.users u LEFT JOIN public.profiles p ON p.id = u.id WHERE p.id IS NULL;
DROP POLICY IF EXISTS "Users can insert their own regular profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can insert/update their profile." ON public.profiles;
DROP POLICY IF EXISTS "Users can insert/update their profile" ON public.profiles;
CREATE POLICY "Users can insert their own regular profile" ON public.profiles FOR INSERT TO authenticated
WITH CHECK (auth.uid() = id AND role = 'member');

CREATE TABLE IF NOT EXISTS public.clips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  storage_path text NOT NULL UNIQUE,
  caption text NOT NULL DEFAULT '' CHECK (char_length(caption) <= 500),
  media_type text NOT NULL CHECK (media_type IN ('image', 'video')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES auth.users
);
ALTER TABLE public.clips ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Approved clips are public; owners and admins can view own" ON public.clips;
DROP POLICY IF EXISTS "Members can submit clips" ON public.clips;
DROP POLICY IF EXISTS "Admins can review clips" ON public.clips;
CREATE POLICY "Approved clips are public; owners and admins can view own" ON public.clips
FOR SELECT TO anon, authenticated USING (
  status = 'approved' OR auth.uid() = user_id OR
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin', 'owner'))
);
CREATE POLICY "Members can submit clips" ON public.clips FOR INSERT TO authenticated
WITH CHECK (auth.uid() = user_id AND (storage_path LIKE auth.uid()::text || '/%') AND status = 'pending' AND reviewed_at IS NULL AND reviewed_by IS NULL);
CREATE POLICY "Admins can review clips" ON public.clips FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin', 'owner')))
WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin', 'owner')));

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('runmate-clips', 'runmate-clips', false, 52428800,
        ARRAY['image/jpeg','image/png','image/webp','video/mp4','video/webm','video/quicktime'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit,
allowed_mime_types = EXCLUDED.allowed_mime_types;
DROP POLICY IF EXISTS "Users upload their own clips" ON storage.objects;
DROP POLICY IF EXISTS "Users read their own clips and approved clips" ON storage.objects;
DROP POLICY IF EXISTS "Admins manage clip files" ON storage.objects;
DROP POLICY IF EXISTS "Users delete their orphan clip uploads" ON storage.objects;
CREATE POLICY "Users upload their own clips" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'runmate-clips' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Users read their own clips and approved clips" ON storage.objects FOR SELECT TO anon, authenticated
USING (bucket_id = 'runmate-clips' AND (
  (storage.foldername(name))[1] = auth.uid()::text OR
  EXISTS (SELECT 1 FROM public.clips c WHERE c.storage_path = name AND c.status = 'approved') OR
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin', 'owner'))
));
CREATE POLICY "Users delete their orphan clip uploads" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'runmate-clips' AND (storage.foldername(name))[1] = auth.uid()::text AND NOT EXISTS (SELECT 1 FROM public.clips c WHERE c.storage_path = name));
CREATE POLICY "Admins manage clip files" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'runmate-clips' AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin', 'owner')));

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('runmate-avatars', 'runmate-avatars', true, 5242880, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = EXCLUDED.file_size_limit,
allowed_mime_types = EXCLUDED.allowed_mime_types;
DROP POLICY IF EXISTS "Profile photos are public" ON storage.objects;
DROP POLICY IF EXISTS "Users upload their own profile photos" ON storage.objects;
DROP POLICY IF EXISTS "Users delete their own profile photos" ON storage.objects;
CREATE POLICY "Profile photos are public" ON storage.objects FOR SELECT TO anon, authenticated
USING (bucket_id = 'runmate-avatars');
CREATE POLICY "Users upload their own profile photos" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'runmate-avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Users delete their own profile photos" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'runmate-avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('runmate-run-images', 'runmate-run-images', true, 5242880, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = EXCLUDED.file_size_limit,
allowed_mime_types = EXCLUDED.allowed_mime_types;
DROP POLICY IF EXISTS "Run images are public" ON storage.objects;
DROP POLICY IF EXISTS "Admins upload run images" ON storage.objects;
DROP POLICY IF EXISTS "Admins delete run images" ON storage.objects;
CREATE POLICY "Run images are public" ON storage.objects FOR SELECT TO anon, authenticated
USING (bucket_id = 'runmate-run-images');
CREATE POLICY "Admins upload run images" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'runmate-run-images' AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin', 'owner')));
CREATE POLICY "Admins delete run images" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'runmate-run-images' AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin', 'owner')));

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('runmate-avatars', 'runmate-avatars', true, 5242880, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = EXCLUDED.file_size_limit,
allowed_mime_types = EXCLUDED.allowed_mime_types;
DROP POLICY IF EXISTS "Profile photos are public" ON storage.objects;
DROP POLICY IF EXISTS "Users upload their own profile photos" ON storage.objects;
DROP POLICY IF EXISTS "Users delete their own profile photos" ON storage.objects;
CREATE POLICY "Profile photos are public" ON storage.objects FOR SELECT TO anon, authenticated
USING (bucket_id = 'runmate-avatars');
CREATE POLICY "Users upload their own profile photos" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'runmate-avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Users delete their own profile photos" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'runmate-avatars' AND (storage.foldername(name))[1] = auth.uid()::text);





