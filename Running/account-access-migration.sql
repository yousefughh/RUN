-- Stride account access and profile-name migration.
-- Safe to run more than once. Account bans are reversible; owners are protected.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_banned boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.is_account_active()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.is_banned = false
  );
$$;
REVOKE ALL ON FUNCTION public.is_account_active() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_account_active() TO authenticated;

CREATE OR REPLACE FUNCTION public.is_admin_or_owner()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.is_account_active() AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.role IN ('admin', 'owner')
  );
$$;
REVOKE ALL ON FUNCTION public.is_admin_or_owner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin_or_owner() TO authenticated;

-- Expose the ban status only through the existing, owner/admin-scoped profile list.
GRANT SELECT (is_banned) ON TABLE public.profiles TO authenticated;

DROP POLICY IF EXISTS "Users see own profile and admins may manage profiles" ON public.profiles;
DROP POLICY IF EXISTS "Users can insert their own regular profile" ON public.profiles;
DROP POLICY IF EXISTS "Users update their own active profile" ON public.profiles;
CREATE POLICY "Users see own profile and admins may manage profiles" ON public.profiles
FOR SELECT TO authenticated
USING (public.is_account_active() AND (id = auth.uid() OR public.is_admin_or_owner()));
CREATE POLICY "Users can insert their own regular profile" ON public.profiles
FOR INSERT TO authenticated
WITH CHECK (public.is_account_active() AND auth.uid() = id AND role = 'member' AND is_banned = false);
CREATE POLICY "Users update their own active profile" ON public.profiles
FOR UPDATE TO authenticated
USING (public.is_account_active() AND id = auth.uid())
WITH CHECK (public.is_account_active() AND id = auth.uid() AND is_banned = false);

-- Apply the active-account gate to all private run, booking, and chat access.
DROP POLICY IF EXISTS "Runs are viewable by authenticated users" ON public.runs;
DROP POLICY IF EXISTS "Admins can insert runs" ON public.runs;
DROP POLICY IF EXISTS "Admins can update runs" ON public.runs;
DROP POLICY IF EXISTS "Admins can delete runs" ON public.runs;
CREATE POLICY "Runs are viewable by authenticated users" ON public.runs
FOR SELECT TO authenticated USING (public.is_account_active());
CREATE POLICY "Admins can insert runs" ON public.runs FOR INSERT TO authenticated
WITH CHECK (public.is_admin_or_owner() AND created_by = auth.uid());
CREATE POLICY "Admins can update runs" ON public.runs FOR UPDATE TO authenticated
USING (public.is_admin_or_owner()) WITH CHECK (public.is_admin_or_owner());
CREATE POLICY "Admins can delete runs" ON public.runs FOR DELETE TO authenticated
USING (public.is_admin_or_owner());

DROP POLICY IF EXISTS "Users see own bookings and admins see all" ON public.bookings;
DROP POLICY IF EXISTS "Users can book themselves" ON public.bookings;
DROP POLICY IF EXISTS "Users cancel own bookings" ON public.bookings;
CREATE POLICY "Users see own bookings and admins see all" ON public.bookings FOR SELECT TO authenticated
USING (public.is_account_active() AND (auth.uid() = user_id OR public.is_admin_or_owner()));
CREATE POLICY "Users can book themselves" ON public.bookings FOR INSERT TO authenticated
WITH CHECK (public.is_account_active() AND auth.uid() = user_id);
CREATE POLICY "Users cancel own bookings" ON public.bookings FOR DELETE TO authenticated
USING (public.is_account_active() AND (auth.uid() = user_id OR public.is_admin_or_owner()));

DROP POLICY IF EXISTS "Booked runners can read chat" ON public.messages;
DROP POLICY IF EXISTS "Authorized runners can send chat messages" ON public.messages;
CREATE POLICY "Booked runners can read chat" ON public.messages FOR SELECT TO authenticated
USING (public.is_account_active() AND (
  EXISTS (SELECT 1 FROM public.bookings b WHERE b.run_id = messages.run_id AND b.user_id = auth.uid())
  OR public.is_admin_or_owner()
));
CREATE POLICY "Authorized runners can send chat messages" ON public.messages FOR INSERT TO authenticated
WITH CHECK (
  public.is_account_active() AND auth.uid() = user_id AND
  (EXISTS (SELECT 1 FROM public.bookings b WHERE b.run_id = messages.run_id AND b.user_id = auth.uid()) OR public.is_admin_or_owner()) AND
  (NOT EXISTS (SELECT 1 FROM public.runs r WHERE r.id = messages.run_id AND r.admin_only_chat) OR public.is_admin_or_owner())
);

-- Keep active owner permissions in sync for the privileged role-management RPC.
CREATE OR REPLACE FUNCTION public.set_profile_role(target_profile_id uuid, requested_role text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('runmate-owner-role-change', 0));
  IF NOT public.is_account_active() OR NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'owner' AND is_banned = false
  ) THEN
    RAISE EXCEPTION 'Only an active owner can manage account roles';
  END IF;
  IF requested_role IS NULL OR requested_role NOT IN ('member', 'admin', 'owner') THEN
    RAISE EXCEPTION 'Invalid account role';
  END IF;
  IF target_profile_id = auth.uid() AND requested_role <> 'owner' THEN
    RAISE EXCEPTION 'An owner cannot remove their own owner role';
  END IF;
  IF requested_role <> 'owner'
     AND EXISTS (SELECT 1 FROM public.profiles WHERE id = target_profile_id AND role = 'owner')
     AND (SELECT count(*) FROM public.profiles WHERE role = 'owner' AND is_banned = false) <= 1 THEN
    RAISE EXCEPTION 'Cannot remove the last owner';
  END IF;
  UPDATE public.profiles SET role = requested_role WHERE id = target_profile_id AND is_banned = false;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found or account is blocked'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.set_profile_role(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_profile_role(uuid, text) TO authenticated;

-- Public clips remain visible to visitors; signed-in accounts must be active.
DROP POLICY IF EXISTS "Approved clips are public; owners and admins can view own" ON public.clips;
DROP POLICY IF EXISTS "Members can submit clips" ON public.clips;
DROP POLICY IF EXISTS "Admins can review clips" ON public.clips;
CREATE POLICY "Approved clips are public; owners and admins can view own" ON public.clips
FOR SELECT TO anon, authenticated USING (
  (auth.uid() IS NULL AND status = 'approved') OR
  (public.is_account_active() AND (
    status = 'approved' OR auth.uid() = user_id OR public.is_admin_or_owner()
  ))
);
CREATE POLICY "Members can submit clips" ON public.clips FOR INSERT TO authenticated
WITH CHECK (public.is_account_active() AND auth.uid() = user_id
  AND storage_path LIKE auth.uid()::text || '/%' AND status = 'pending'
  AND reviewed_at IS NULL AND reviewed_by IS NULL);
CREATE POLICY "Admins can review clips" ON public.clips FOR UPDATE TO authenticated
USING (public.is_admin_or_owner()) WITH CHECK (public.is_admin_or_owner());

DROP POLICY IF EXISTS "Users upload their own clips" ON storage.objects;
DROP POLICY IF EXISTS "Users read their own clips and approved clips" ON storage.objects;
DROP POLICY IF EXISTS "Users delete their orphan clip uploads" ON storage.objects;
DROP POLICY IF EXISTS "Admins manage clip files" ON storage.objects;
CREATE POLICY "Users upload their own clips" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (public.is_account_active() AND bucket_id = 'runmate-clips'
  AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Users read their own clips and approved clips" ON storage.objects FOR SELECT TO anon, authenticated
USING (bucket_id = 'runmate-clips' AND (
  (auth.uid() IS NULL AND EXISTS (SELECT 1 FROM public.clips c WHERE c.storage_path = name AND c.status = 'approved'))
  OR (public.is_account_active() AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR EXISTS (SELECT 1 FROM public.clips c WHERE c.storage_path = name AND c.status = 'approved')
    OR public.is_admin_or_owner()
  ))
));
CREATE POLICY "Users delete their orphan clip uploads" ON storage.objects FOR DELETE TO authenticated
USING (public.is_account_active() AND bucket_id = 'runmate-clips'
  AND (storage.foldername(name))[1] = auth.uid()::text
  AND NOT EXISTS (SELECT 1 FROM public.clips c WHERE c.storage_path = name));
CREATE POLICY "Admins manage clip files" ON storage.objects FOR DELETE TO authenticated
USING (public.is_admin_or_owner() AND bucket_id = 'runmate-clips');

-- Private account and chat photos reject all access from blocked accounts.
DROP POLICY IF EXISTS "Profile photos are private to their owner and admins" ON storage.objects;
DROP POLICY IF EXISTS "Users upload their own profile photos" ON storage.objects;
DROP POLICY IF EXISTS "Users delete their own profile photos" ON storage.objects;
DROP POLICY IF EXISTS "Run participants can view each other's chat avatars" ON storage.objects;
CREATE POLICY "Profile photos are private to their owner and admins" ON storage.objects FOR SELECT TO authenticated
USING (public.is_account_active() AND bucket_id = 'runmate-avatars'
  AND ((storage.foldername(name))[1] = auth.uid()::text OR public.is_admin_or_owner()));
CREATE POLICY "Users upload their own profile photos" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (public.is_account_active() AND bucket_id = 'runmate-avatars'
  AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Users delete their own profile photos" ON storage.objects FOR DELETE TO authenticated
USING (public.is_account_active() AND bucket_id = 'runmate-avatars'
  AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE OR REPLACE FUNCTION public.can_view_run_chat_avatar(avatar_file_path text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.is_account_active() AND (
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
CREATE POLICY "Run participants can view each other's chat avatars" ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'runmate-avatars' AND public.can_view_run_chat_avatar(name));

-- Run images are public assets, but blocked users cannot upload or delete them.
DROP POLICY IF EXISTS "Admins upload run images" ON storage.objects;
DROP POLICY IF EXISTS "Admins delete run images" ON storage.objects;
CREATE POLICY "Admins upload run images" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (public.is_admin_or_owner() AND bucket_id = 'runmate-run-images');
CREATE POLICY "Admins delete run images" ON storage.objects FOR DELETE TO authenticated
USING (public.is_admin_or_owner() AND bucket_id = 'runmate-run-images');

-- A definer RPC bypasses table RLS, so check the account status explicitly.
CREATE OR REPLACE FUNCTION public.get_run_chat_messages(p_run_id uuid)
RETURNS TABLE (id uuid, body text, created_at timestamptz, sender_name text, avatar_path text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT public.is_account_active() OR NOT (
    EXISTS (SELECT 1 FROM public.bookings b WHERE b.run_id = p_run_id AND b.user_id = auth.uid())
    OR public.is_admin_or_owner()
  ) THEN
    RAISE EXCEPTION 'chat_access_denied';
  END IF;

  RETURN QUERY
  SELECT m.id, m.body, m.created_at,
         COALESCE(NULLIF(p.display_name, ''), 'Stride member'), p.avatar_path
  FROM public.messages m
  LEFT JOIN public.profiles p ON p.id = m.user_id
  WHERE m.run_id = p_run_id
  ORDER BY m.created_at DESC
  LIMIT 300;
END;
$$;
REVOKE ALL ON FUNCTION public.get_run_chat_messages(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_run_chat_messages(uuid) TO authenticated;
