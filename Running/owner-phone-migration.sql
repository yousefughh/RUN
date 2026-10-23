-- Allow only the site owner to see member phone numbers in the admin user list.
-- Re-running this migration is safe.
DROP FUNCTION IF EXISTS public.list_owner_users();

CREATE FUNCTION public.list_owner_users()
RETURNS TABLE (
  id uuid,
  email text,
  phone text,
  display_name text,
  avatar_path text,
  role text,
  created_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'owner_access_required';
  END IF;

  RETURN QUERY
  SELECT p.id, u.email::text, COALESCE(p.phone, NULLIF(u.raw_user_meta_data ->> 'phone', '')), p.display_name, p.avatar_path, p.role, p.created_at
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.id
  ORDER BY p.created_at DESC
  LIMIT 500;
END;
$$;

REVOKE ALL ON FUNCTION public.list_owner_users() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_owner_users() TO authenticated;
