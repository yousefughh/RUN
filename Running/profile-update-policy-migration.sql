-- Restore secure self-update access for profile fields such as avatar_path.
-- The authenticated user can update only their own row; column grants still
-- restrict which fields are writable, and the role trigger prevents role edits.
DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Members can update their own profile fields" ON public.profiles;
CREATE POLICY "Members can update their own profile fields" ON public.profiles
FOR UPDATE TO authenticated
USING (auth.uid() = id)
WITH CHECK (auth.uid() = id);

GRANT UPDATE (display_name, avatar_path, phone, birth_date)
ON TABLE public.profiles TO authenticated;
