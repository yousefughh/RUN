-- RUNMATE database schema for Supabase
-- You can run this script again safely for the policies and triggers defined below.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  display_name text,
  phone text,
  birth_date date,
  avatar_path text,
  role text not null default 'member' check (role in ('member', 'admin', 'owner')),
  created_at timestamptz not null default now()
);
alter table public.profiles add column if not exists birth_date date;

create table if not exists public.runs (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  starts_at timestamptz not null,
  location text not null,
  distance_km numeric not null default 5 check (distance_km > 0),
  seats_total integer not null default 15 check (seats_total > 0),
  seats_booked integer not null default 0 check (seats_booked >= 0),
  run_status text not null default 'automatic' check (run_status in ('automatic', 'upcoming', 'current', 'previous')),
  duration_minutes integer not null default 90 check (duration_minutes between 15 and 1440),
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
create or replace function public.sync_run_seats_booked()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    update public.runs
    set seats_booked = seats_booked + 1
    where id = new.run_id and seats_booked < seats_total;
    if not found then raise exception 'Run is full or has no available seats'; end if;
    return new;
  elsif tg_op = 'DELETE' then
    update public.runs
    set seats_booked = greatest(seats_booked - 1, 0)
    where id = old.run_id;
    return old;
  end if;
  return null;
end;
$$;
drop trigger if exists bookings_sync_run_seats_after_insert on public.bookings;
drop trigger if exists bookings_sync_run_seats_after_delete on public.bookings;
create trigger bookings_sync_run_seats_after_insert
after insert on public.bookings for each row
execute function public.sync_run_seats_booked();
create trigger bookings_sync_run_seats_after_delete
after delete on public.bookings for each row
execute function public.sync_run_seats_booked();

-- Automatically register the run creator so they can attend and use its chat.
create or replace function public.register_run_creator()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.created_by is not null then
    insert into public.bookings (run_id, user_id) values (new.id, new.created_by)
    on conflict (run_id, user_id) do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists runs_register_creator_after_insert on public.runs;
create trigger runs_register_creator_after_insert
after insert on public.runs for each row execute function public.register_run_creator();

-- Do not accept registrations after a run has ended.
create or replace function public.prevent_booking_after_run()
returns trigger language plpgsql security definer set search_path = '' as $$
declare run_record public.runs%rowtype;
begin
  select * into run_record from public.runs where id = new.run_id;
  if run_record.run_status = 'previous'
     or (now() >= run_record.starts_at - interval '30 minutes'
         and new.user_id <> run_record.created_by) then
    raise exception 'run_closed';
  end if;
  return new;
end;
$$;
drop trigger if exists bookings_reject_closed_run on public.bookings;
create trigger bookings_reject_closed_run
before insert on public.bookings for each row execute function public.prevent_booking_after_run();

drop trigger if exists bookings_keep_creator_registered on public.bookings;
drop function if exists public.prevent_creator_booking_delete();

create or replace function public.reset_run_after_booking_cancel()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.runs
  set run_status = 'automatic'
  where id = old.run_id and starts_at > now();
  return old;
end;
$$;
drop trigger if exists bookings_reset_run_status_after_delete on public.bookings;
create trigger bookings_reset_run_status_after_delete
after delete on public.bookings for each row execute function public.reset_run_after_booking_cancel();

update public.runs r set seats_booked = (
  select count(*)::integer from public.bookings b where b.run_id = r.id
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references public.runs on delete cascade not null,
  user_id uuid references auth.users on delete cascade not null,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index if not exists idx_runs_starts_at on public.runs (starts_at);
create index if not exists idx_bookings_user_created on public.bookings (user_id, created_at desc);
create index if not exists idx_messages_run_created on public.messages (run_id, created_at desc);

-- Automatically create a profile even when email confirmation is required.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, phone, birth_date, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(coalesce(new.email, ''), '@', 1), 'Runwise Egypt member'),
    nullif(new.raw_user_meta_data ->> 'phone', ''),
    nullif(new.raw_user_meta_data ->> 'birth_date', '')::date,
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

-- Never allow a client session to alter roles directly. Role changes must go through
-- the owner-only SECURITY DEFINER function below.
create or replace function public.protect_profile_role()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.role is distinct from old.role
     and current_user not in ('postgres', 'service_role') then
    raise exception 'Account roles can only be changed through the owner role-management function';
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

-- Expose only the caller's own profile unless the caller is an admin or owner.
create or replace function public.is_admin_or_owner()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('admin', 'owner')
  );
$$;
revoke all on function public.is_admin_or_owner() from public, anon;
grant execute on function public.is_admin_or_owner() to authenticated;

alter table public.profiles enable row level security;
alter table public.runs enable row level security;
alter table public.bookings enable row level security;
alter table public.messages enable row level security;

-- Drop policies from earlier versions before recreating them.
do $$
declare policy_record record;
begin
  for policy_record in
    select schemaname, tablename, policyname from pg_policies
    where schemaname = 'public' and tablename in ('profiles', 'runs', 'bookings', 'messages')
  loop
    execute format('drop policy %I on %I.%I', policy_record.policyname, policy_record.schemaname, policy_record.tablename);
  end loop;
end $$;
drop policy if exists "Public profiles are viewable by everyone." on public.profiles;
drop policy if exists "Profiles are viewable by authenticated users" on public.profiles;
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

create policy "Users see own profile and admins may manage profiles"
on public.profiles for select to authenticated using (id = auth.uid() or public.is_admin_or_owner());

create policy "Users can insert their own regular profile"
on public.profiles for insert to authenticated
with check (auth.uid() = id and role = 'member');

create policy "Users can update their own profile"
on public.profiles for update to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

-- Do not expose stored phone numbers through the public API. Grant only the
-- profile fields used by the site, and restrict profile edits to name and avatar.
revoke select, update on table public.profiles from public, anon, authenticated;
grant select (id, display_name, avatar_path, role, created_at) on table public.profiles to authenticated;
grant select (id, role) on table public.profiles to anon;
grant update (display_name, avatar_path, phone, birth_date) on table public.profiles to authenticated;

create policy "Runs are viewable by everyone"
on public.runs for select using (true);

-- Never return the creator's auth UUID through the public application API.
revoke select on table public.runs from public, anon, authenticated;
grant select (id, title, starts_at, location, distance_km, seats_total, seats_booked,
              run_status, duration_minutes, price, image_url, admin_only_chat,
              created_at) on table public.runs to authenticated;
revoke insert, update, delete on table public.runs from public, anon, authenticated;
grant insert (title, starts_at, location, distance_km, seats_total, price, image_url,
              admin_only_chat, run_status, duration_minutes, organizer_name, created_by)
on table public.runs to authenticated;
grant update (run_status, duration_minutes, admin_only_chat) on table public.runs to authenticated;
grant delete on table public.runs to authenticated;

create policy "Admins can insert runs"
on public.runs for insert to authenticated
with check (created_by = auth.uid() and exists (select 1 from public.profiles where id = auth.uid() and role IN ('admin', 'owner')));

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
revoke all on table public.bookings from public, anon, authenticated;
grant select (run_id, user_id) on table public.bookings to authenticated;
grant insert (run_id, user_id) on table public.bookings to authenticated;
grant delete on table public.bookings to authenticated;

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

-- Chat participants can read messages, but not the sender's stable auth UUID.
revoke select on table public.messages from public, anon, authenticated;
grant select (id, run_id, body, created_at) on table public.messages to authenticated;
revoke insert, update, delete on table public.messages from public, anon, authenticated;
grant insert (run_id, user_id, body) on table public.messages to authenticated;

-- Enable live chat updates for the browser's filtered INSERT subscription.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'messages'
     ) then
    execute 'alter publication supabase_realtime add table public.messages';
  elsif not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publication is missing; enable Realtime for public.messages in Supabase.';
  end if;
end $$;
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
  INSERT INTO public.profiles (id, display_name, phone, birth_date, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data ->> 'display_name', NULLIF(split_part(COALESCE(NEW.email, ''), '@', 1), ''), 'Runwise Egypt member'),
    NULLIF(NEW.raw_user_meta_data ->> 'phone', ''),
    NULLIF(NEW.raw_user_meta_data ->> 'birth_date', '')::date,
    'member'
  ) ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
INSERT INTO public.profiles (id, display_name, phone, birth_date, role)
SELECT u.id, COALESCE(u.raw_user_meta_data ->> 'display_name', NULLIF(split_part(COALESCE(u.email, ''), '@', 1), '')),
       NULLIF(u.raw_user_meta_data ->> 'phone', ''), NULLIF(u.raw_user_meta_data ->> 'birth_date', '')::date, 'member'
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
REVOKE ALL ON TABLE public.clips FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, storage_path, caption, media_type, status, created_at) ON TABLE public.clips TO anon, authenticated;
GRANT INSERT (user_id, storage_path, caption, media_type, status) ON TABLE public.clips TO authenticated;
GRANT UPDATE (status, reviewed_at, reviewed_by) ON TABLE public.clips TO authenticated;

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
VALUES ('runmate-avatars', 'runmate-avatars', false, 5242880, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit,
allowed_mime_types = EXCLUDED.allowed_mime_types;
DROP POLICY IF EXISTS "Profile photos are public" ON storage.objects;
DROP POLICY IF EXISTS "Profile photos are private to their owner and admins" ON storage.objects;
DROP POLICY IF EXISTS "Users upload their own profile photos" ON storage.objects;
DROP POLICY IF EXISTS "Users delete their own profile photos" ON storage.objects;
CREATE POLICY "Profile photos are private to their owner and admins" ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'runmate-avatars' AND ((storage.foldername(name))[1] = auth.uid()::text OR public.is_admin_or_owner()));
CREATE POLICY "Users upload their own profile photos" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'runmate-avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Users delete their own profile photos" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'runmate-avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Let a runner view only the avatars of people booked into a run they can access.
CREATE OR REPLACE FUNCTION public.can_view_run_chat_avatar(avatar_file_path text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT auth.uid() IS NOT NULL AND (
    public.is_admin_or_owner() OR EXISTS (
      SELECT 1
      FROM public.profiles owner_profile
      JOIN public.bookings owner_booking ON owner_booking.user_id = owner_profile.id
      JOIN public.bookings viewer_booking ON viewer_booking.run_id = owner_booking.run_id
      WHERE owner_profile.avatar_path = avatar_file_path
        AND viewer_booking.user_id = auth.uid()
    )
  );
$$;
REVOKE ALL ON FUNCTION public.can_view_run_chat_avatar(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_run_chat_avatar(text) TO authenticated;
DROP POLICY IF EXISTS "Run participants can view each other's chat avatars" ON storage.objects;
CREATE POLICY "Run participants can view each other's chat avatars" ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'runmate-avatars' AND public.can_view_run_chat_avatar(name));

-- Return chat messages with only the sender name and private avatar path.
CREATE OR REPLACE FUNCTION public.get_run_chat_messages(p_run_id uuid)
RETURNS TABLE (id uuid, body text, created_at timestamptz, sender_name text, avatar_path text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT (
    EXISTS (SELECT 1 FROM public.bookings b WHERE b.run_id = p_run_id AND b.user_id = auth.uid())
    OR public.is_admin_or_owner()
  ) THEN
    RAISE EXCEPTION 'chat_access_denied';
  END IF;

  RETURN QUERY
  SELECT m.id, m.body, m.created_at,
         COALESCE(NULLIF(p.display_name, ''), 'Runwise Egypt member'), p.avatar_path
  FROM public.messages m
  LEFT JOIN public.profiles p ON p.id = m.user_id
  WHERE m.run_id = p_run_id
  ORDER BY m.created_at DESC
  LIMIT 300;
END;
$$;
REVOKE ALL ON FUNCTION public.get_run_chat_messages(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_run_chat_messages(uuid) TO authenticated;

-- Private profile details are returned only to the signed-in account owner.
CREATE OR REPLACE FUNCTION public.get_my_profile_details()
RETURNS TABLE (birth_date date, phone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.birth_date, p.phone FROM public.profiles p WHERE p.id = auth.uid();
$$;
REVOKE ALL ON FUNCTION public.get_my_profile_details() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_profile_details() TO authenticated;

-- A runner can list names and photos only for a run they joined; emails are excluded.
CREATE OR REPLACE FUNCTION public.get_run_participants(p_run_id uuid)
RETURNS TABLE (display_name text, avatar_path text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT (
    EXISTS (SELECT 1 FROM public.bookings b WHERE b.run_id = p_run_id AND b.user_id = auth.uid())
    OR public.is_admin_or_owner()
  ) THEN
    RAISE EXCEPTION 'chat_access_denied';
  END IF;
  RETURN QUERY
  SELECT COALESCE(NULLIF(p.display_name, ''), 'Runwise Egypt member'), p.avatar_path
  FROM public.bookings b
  JOIN public.profiles p ON p.id = b.user_id
  WHERE b.run_id = p_run_id
  ORDER BY lower(COALESCE(p.display_name, ''));
END;
$$;
REVOKE ALL ON FUNCTION public.get_run_participants(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_run_participants(uuid) TO authenticated;

-- Only the owner can retrieve other accounts' email addresses for the admin page.
CREATE OR REPLACE FUNCTION public.list_owner_users()
RETURNS TABLE (id uuid, email text, display_name text, avatar_path text, role text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'owner_access_required';
  END IF;
  RETURN QUERY
  SELECT p.id, u.email::text, p.display_name, p.avatar_path, p.role, p.created_at
  FROM public.profiles p JOIN auth.users u ON u.id = p.id
  ORDER BY p.created_at DESC LIMIT 500;
END;
$$;
REVOKE ALL ON FUNCTION public.list_owner_users() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_owner_users() TO authenticated;

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
VALUES ('runmate-avatars', 'runmate-avatars', false, 5242880, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit,
allowed_mime_types = EXCLUDED.allowed_mime_types;
DROP POLICY IF EXISTS "Profile photos are public" ON storage.objects;
DROP POLICY IF EXISTS "Profile photos are private to their owner and admins" ON storage.objects;
DROP POLICY IF EXISTS "Users upload their own profile photos" ON storage.objects;
DROP POLICY IF EXISTS "Users delete their own profile photos" ON storage.objects;
CREATE POLICY "Profile photos are private to their owner and admins" ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'runmate-avatars' AND ((storage.foldername(name))[1] = auth.uid()::text OR public.is_admin_or_owner()));
CREATE POLICY "Users upload their own profile photos" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'runmate-avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Users delete their own profile photos" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'runmate-avatars' AND (storage.foldername(name))[1] = auth.uid()::text);




