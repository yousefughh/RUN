-- RUNMATE compatibility and Clips migration. Safe to re-run; preserves users and existing profiles.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS avatar_path text;
ALTER TABLE public.runs ADD COLUMN IF NOT EXISTS seats_booked integer NOT NULL DEFAULT 0;
ALTER TABLE public.runs ADD COLUMN IF NOT EXISTS run_status text NOT NULL DEFAULT 'automatic';
ALTER TABLE public.runs ADD COLUMN IF NOT EXISTS duration_minutes integer NOT NULL DEFAULT 90;
ALTER TABLE public.runs DROP CONSTRAINT IF EXISTS runs_run_status_check;
ALTER TABLE public.runs ADD CONSTRAINT runs_run_status_check CHECK (run_status IN ('automatic', 'upcoming', 'current', 'previous'));
ALTER TABLE public.runs DROP CONSTRAINT IF EXISTS runs_duration_minutes_check;
ALTER TABLE public.runs ADD CONSTRAINT runs_duration_minutes_check CHECK (duration_minutes BETWEEN 15 AND 1440);
-- Keep available seats in sync with bookings and reject overbooking.
CREATE OR REPLACE FUNCTION public.sync_run_seats_booked()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.runs
    SET seats_booked = seats_booked + 1
    WHERE id = NEW.run_id AND seats_booked < seats_total;
    IF NOT FOUND THEN RAISE EXCEPTION 'Run is full or has no available seats'; END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.runs
    SET seats_booked = GREATEST(seats_booked - 1, 0)
    WHERE id = OLD.run_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS bookings_sync_run_seats_after_insert ON public.bookings;
DROP TRIGGER IF EXISTS bookings_sync_run_seats_after_delete ON public.bookings;
CREATE TRIGGER bookings_sync_run_seats_after_insert
AFTER INSERT ON public.bookings FOR EACH ROW
EXECUTE FUNCTION public.sync_run_seats_booked();
CREATE TRIGGER bookings_sync_run_seats_after_delete
AFTER DELETE ON public.bookings FOR EACH ROW
EXECUTE FUNCTION public.sync_run_seats_booked();

CREATE OR REPLACE FUNCTION public.register_run_creator()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.created_by IS NOT NULL THEN
    INSERT INTO public.bookings (run_id, user_id) VALUES (NEW.id, NEW.created_by)
    ON CONFLICT (run_id, user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS runs_register_creator_after_insert ON public.runs;
CREATE TRIGGER runs_register_creator_after_insert AFTER INSERT ON public.runs
FOR EACH ROW EXECUTE FUNCTION public.register_run_creator();

CREATE OR REPLACE FUNCTION public.prevent_booking_after_run()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE run_record public.runs%ROWTYPE;
BEGIN
  SELECT * INTO run_record FROM public.runs WHERE id = NEW.run_id;
  IF run_record.run_status = 'previous'
     OR (run_record.run_status = 'automatic'
         AND now() >= run_record.starts_at + pg_catalog.make_interval(mins => run_record.duration_minutes)) THEN
    RAISE EXCEPTION 'run_closed';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS bookings_reject_closed_run ON public.bookings;
CREATE TRIGGER bookings_reject_closed_run BEFORE INSERT ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.prevent_booking_after_run();

CREATE OR REPLACE FUNCTION public.prevent_creator_booking_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.runs WHERE id = OLD.run_id AND created_by = OLD.user_id) THEN
    RAISE EXCEPTION 'organizer_registration_required';
  END IF;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS bookings_keep_creator_registered ON public.bookings;
CREATE TRIGGER bookings_keep_creator_registered BEFORE DELETE ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.prevent_creator_booking_delete();

UPDATE public.runs r SET seats_booked = (
  SELECT COUNT(*)::integer FROM public.bookings b WHERE b.run_id = r.id
);
CREATE INDEX IF NOT EXISTS idx_runs_starts_at ON public.runs (starts_at);
CREATE INDEX IF NOT EXISTS idx_bookings_user_created ON public.bookings (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_run_created ON public.messages (run_id, created_at DESC);
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

CREATE OR REPLACE FUNCTION public.protect_profile_role()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role
     AND current_user NOT IN ('postgres', 'service_role') THEN
    RAISE EXCEPTION 'Account roles can only be changed through the owner role-management function';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_profile_role(target_profile_id uuid, requested_role text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('runmate-owner-role-change', 0));
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Only an owner can manage account roles';
  END IF;
  IF requested_role IS NULL OR requested_role NOT IN ('member', 'admin', 'owner') THEN
    RAISE EXCEPTION 'Invalid account role';
  END IF;
  IF target_profile_id = auth.uid() AND requested_role <> 'owner' THEN
    RAISE EXCEPTION 'An owner cannot remove their own owner role';
  END IF;
  IF requested_role <> 'owner'
     AND EXISTS (SELECT 1 FROM public.profiles WHERE id = target_profile_id AND role = 'owner')
     AND (SELECT count(*) FROM public.profiles WHERE role = 'owner') <= 1 THEN
    RAISE EXCEPTION 'Cannot remove the last owner';
  END IF;
  UPDATE public.profiles SET role = requested_role WHERE id = target_profile_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.set_profile_role(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_profile_role(uuid, text) TO authenticated;

-- Keep existing phone values in the database but make them unavailable through
-- the browser API. The public profile fields below are the only ones clients can read.
REVOKE ALL ON TABLE public.profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, display_name, avatar_path, role, created_at) ON TABLE public.profiles TO authenticated;
GRANT UPDATE (display_name, avatar_path) ON TABLE public.profiles TO authenticated;

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

CREATE OR REPLACE FUNCTION public.is_admin_or_owner()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin', 'owner'));
$$;
REVOKE ALL ON FUNCTION public.is_admin_or_owner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin_or_owner() TO authenticated;

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

-- Restrict personal profile visibility and expose only fields required by the client.
CREATE OR REPLACE FUNCTION public.is_admin_or_owner()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin', 'owner'));
$$;
REVOKE ALL ON FUNCTION public.is_admin_or_owner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin_or_owner() TO authenticated;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT schemaname, tablename, policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename IN ('profiles', 'runs', 'bookings', 'messages')
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
  END LOOP;
END $$;
DROP POLICY IF EXISTS "Public profiles are viewable by everyone." ON public.profiles;
DROP POLICY IF EXISTS "Profiles are viewable by authenticated users" ON public.profiles;
DROP POLICY IF EXISTS "Users see own profile and admins may manage profiles" ON public.profiles;
CREATE POLICY "Users see own profile and admins may manage profiles" ON public.profiles
FOR SELECT TO authenticated USING (id = auth.uid() OR public.is_admin_or_owner());

-- Keep auth UUIDs and contact details out of public list responses.
ALTER TABLE public.runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Runs are viewable by everyone." ON public.runs;
DROP POLICY IF EXISTS "Runs are viewable by everyone" ON public.runs;
DROP POLICY IF EXISTS "Admins can insert runs." ON public.runs;
DROP POLICY IF EXISTS "Admins can insert runs" ON public.runs;
DROP POLICY IF EXISTS "Admins can update runs." ON public.runs;
DROP POLICY IF EXISTS "Admins can update runs" ON public.runs;
DROP POLICY IF EXISTS "Admins can delete runs." ON public.runs;
DROP POLICY IF EXISTS "Admins can delete runs" ON public.runs;
CREATE POLICY "Runs are viewable by authenticated users" ON public.runs
FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins can insert runs" ON public.runs FOR INSERT TO authenticated
WITH CHECK (public.is_admin_or_owner() AND created_by = auth.uid());
CREATE POLICY "Admins can update runs" ON public.runs FOR UPDATE TO authenticated
USING (public.is_admin_or_owner()) WITH CHECK (public.is_admin_or_owner());
CREATE POLICY "Admins can delete runs" ON public.runs FOR DELETE TO authenticated
USING (public.is_admin_or_owner());
REVOKE ALL ON TABLE public.runs FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, title, starts_at, location, distance_km, seats_total, seats_booked,
              run_status, duration_minutes, price, image_url, admin_only_chat,
              created_at) ON TABLE public.runs TO authenticated;
GRANT INSERT (title, starts_at, location, distance_km, seats_total, price, image_url,
              admin_only_chat, run_status, duration_minutes, organizer_name, created_by)
ON TABLE public.runs TO authenticated;
GRANT UPDATE (run_status, duration_minutes, admin_only_chat) ON TABLE public.runs TO authenticated;
GRANT DELETE ON TABLE public.runs TO authenticated;

ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Bookings viewable by owner." ON public.bookings;
DROP POLICY IF EXISTS "Bookings viewable by owner" ON public.bookings;
DROP POLICY IF EXISTS "Users can insert bookings." ON public.bookings;
DROP POLICY IF EXISTS "Users can insert bookings" ON public.bookings;
DROP POLICY IF EXISTS "Users can delete own bookings." ON public.bookings;
DROP POLICY IF EXISTS "Users can delete own bookings" ON public.bookings;
CREATE POLICY "Users see own bookings and admins see all" ON public.bookings FOR SELECT TO authenticated
USING (auth.uid() = user_id OR public.is_admin_or_owner());
CREATE POLICY "Users can book themselves" ON public.bookings FOR INSERT TO authenticated
WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users cancel own bookings" ON public.bookings FOR DELETE TO authenticated
USING (auth.uid() = user_id OR public.is_admin_or_owner());
REVOKE ALL ON TABLE public.bookings FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, run_id, user_id, created_at) ON TABLE public.bookings TO authenticated;
GRANT INSERT (run_id, user_id) ON TABLE public.bookings TO authenticated;
GRANT DELETE ON TABLE public.bookings TO authenticated;

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Messages viewable by bookers or admins." ON public.messages;
DROP POLICY IF EXISTS "Messages viewable by bookers or admins" ON public.messages;
DROP POLICY IF EXISTS "Messages insert by authorized users or admins." ON public.messages;
DROP POLICY IF EXISTS "Messages insert by authorized users or admins" ON public.messages;
CREATE POLICY "Booked runners can read chat" ON public.messages FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.bookings b WHERE b.run_id = messages.run_id AND b.user_id = auth.uid()) OR public.is_admin_or_owner());
CREATE POLICY "Authorized runners can send chat messages" ON public.messages FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() = user_id AND
  (EXISTS (SELECT 1 FROM public.bookings b WHERE b.run_id = messages.run_id AND b.user_id = auth.uid()) OR public.is_admin_or_owner()) AND
  (NOT EXISTS (SELECT 1 FROM public.runs r WHERE r.id = messages.run_id AND r.admin_only_chat) OR public.is_admin_or_owner())
);
REVOKE ALL ON TABLE public.messages FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, run_id, body, created_at) ON TABLE public.messages TO authenticated;
GRANT INSERT (run_id, user_id, body) ON TABLE public.messages TO authenticated;


