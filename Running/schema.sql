-- RUNMATE database schema for Supabase
-- You can run this script again safely for the policies and triggers defined below.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  display_name text,
  phone text,
  role text not null default 'user' check (role in ('user', 'admin')),
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
    'user'
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
       where p.id = auth.uid() and p.role = 'admin'
     ) then
    raise exception 'Only an administrator can change account roles';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile_role_trigger on public.profiles;
create trigger protect_profile_role_trigger
before update on public.profiles
for each row execute procedure public.protect_profile_role();

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
with check (auth.uid() = id and role = 'user');

create policy "Users can update their own profile"
on public.profiles for update to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

create policy "Runs are viewable by everyone"
on public.runs for select using (true);

create policy "Admins can insert runs"
on public.runs for insert to authenticated
with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

create policy "Admins can update runs"
on public.runs for update to authenticated
using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'))
with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

create policy "Admins can delete runs"
on public.runs for delete to authenticated
using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

create policy "Bookings viewable by owner"
on public.bookings for select to authenticated
using (auth.uid() = user_id or exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

create policy "Users can insert bookings"
on public.bookings for insert to authenticated
with check (auth.uid() = user_id);

create policy "Users can delete own bookings"
on public.bookings for delete to authenticated
using (auth.uid() = user_id or exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

create policy "Messages viewable by bookers or admins"
on public.messages for select to authenticated
using (
  exists (select 1 from public.bookings where bookings.run_id = messages.run_id and bookings.user_id = auth.uid())
  or exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
);

create policy "Messages insert by authorized users or admins"
on public.messages for insert to authenticated
with check (
  auth.uid() = user_id and (
    exists (select 1 from public.bookings where bookings.run_id = messages.run_id and bookings.user_id = auth.uid())
    or exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  ) and (
    not exists (select 1 from public.runs where runs.id = messages.run_id and runs.admin_only_chat = true)
    or exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  )
);
