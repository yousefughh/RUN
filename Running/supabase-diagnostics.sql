-- Read-only checks for the live signup trigger and profile schema.
-- Run in Supabase SQL Editor and share the result rows if signup still fails.

-- Every non-internal trigger attached to auth.users and its function.
SELECT t.tgname AS trigger_name,
       pg_get_triggerdef(t.oid, true) AS trigger_definition,
       n.nspname AS function_schema,
       p.proname AS function_name,
       pg_get_functiondef(p.oid) AS function_definition
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace table_schema ON table_schema.oid = c.relnamespace
JOIN pg_proc p ON p.oid = t.tgfoid
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE table_schema.nspname = 'auth'
  AND c.relname = 'users'
  AND NOT t.tgisinternal
ORDER BY t.tgname;

-- Actual profile columns, types, nullability, and defaults.
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'profiles'
ORDER BY ordinal_position;

-- Actual profile check constraints.
SELECT conname, pg_get_constraintdef(oid, true) AS definition
FROM pg_constraint
WHERE conrelid = 'public.profiles'::regclass AND contype = 'c'
ORDER BY conname;

-- Actual profile RLS policies.
SELECT policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'profiles'
ORDER BY policyname;

