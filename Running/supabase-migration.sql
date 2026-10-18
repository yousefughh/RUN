-- RUNMATE compatibility and Clips migration. Safe to re-run; preserves users and existing profiles.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS avatar_path text;
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
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check CHECK (role IN ('member', 'admin'));

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
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
);
CREATE POLICY "Members can submit clips" ON public.clips FOR INSERT TO authenticated
WITH CHECK (auth.uid() = user_id AND (storage_path LIKE auth.uid()::text || '/%') AND status = 'pending' AND reviewed_at IS NULL AND reviewed_by IS NULL);
CREATE POLICY "Admins can review clips" ON public.clips FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'))
WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'));

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
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
));
CREATE POLICY "Users delete their orphan clip uploads" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'runmate-clips' AND (storage.foldername(name))[1] = auth.uid()::text AND NOT EXISTS (SELECT 1 FROM public.clips c WHERE c.storage_path = name));
CREATE POLICY "Admins manage clip files" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'runmate-clips' AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'));

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


