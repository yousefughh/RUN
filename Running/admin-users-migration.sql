-- Let authenticated admins view the limited member fields needed by the admin dashboard.
-- Email and phone remain available only through list_owner_users().
CREATE OR REPLACE FUNCTION public.list_admin_users()
RETURNS TABLE (
  id uuid,
  display_name text,
  avatar_path text,
  role text,
  created_at timestamptz,
  is_banned boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.profiles caller
    WHERE caller.id = auth.uid()
      AND caller.role IN ('admin', 'owner')
  ) THEN
    RAISE EXCEPTION 'admin_access_required';
  END IF;

  RETURN QUERY
  SELECT p.id, p.display_name, p.avatar_path, p.role, p.created_at, p.is_banned
  FROM public.profiles p
  ORDER BY p.created_at DESC
  LIMIT 500;
END;
$$;

REVOKE ALL ON FUNCTION public.list_admin_users() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_admin_users() TO authenticated;
