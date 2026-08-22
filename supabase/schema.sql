-- Schema for the AUA waiver page. Run this once against a fresh Supabase
-- project (SQL Editor, or `supabase db execute -f supabase/schema.sql`).
--
-- The table lives in its own `wv` schema rather than `public` so it stays
-- isolated if this project is ever shared with other apps. PostgREST (and
-- any supabase-js client, including from an Edge Function) only exposes the
-- `public` schema by default, and there is no supported way to change that
-- from SQL alone — so writes go through the `public.submit_waiver_signature`
-- RPC below instead of a direct table insert. Keep that RPC in `public`.

create schema if not exists wv;

create table if not exists wv.waiver_signatures (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  signed_date date not null,
  signature_image text not null,
  dob date,
  phone text,
  address text,
  city text,
  state text,
  zip text,
  minor_info text,
  guardian_print_name text,
  guardian_dob date,
  guardian_signature_image text,
  guardian_date date,
  created_at timestamptz not null default now()
);

-- RLS enabled with no policies: nothing is directly readable or writable by
-- the anon/authenticated roles. All access goes through the SECURITY
-- DEFINER function below (owned by `postgres`, which bypasses RLS).
alter table wv.waiver_signatures enable row level security;

-- Drop the previous 14-arg signature before recreating with the new
-- p_guardian_dob parameter: CREATE OR REPLACE cannot change a function's
-- parameter list, only its body, so a changed signature otherwise creates
-- a second overload instead of replacing the original.
drop function if exists public.submit_waiver_signature(
  text, text, date, text, date, text, text, text, text, text, text, text, text, date
);

create or replace function public.submit_waiver_signature(
  p_name text,
  p_email text,
  p_signed_date date,
  p_signature_image text,
  p_dob date default null,
  p_phone text default null,
  p_address text default null,
  p_city text default null,
  p_state text default null,
  p_zip text default null,
  p_minor_info text default null,
  p_guardian_print_name text default null,
  p_guardian_dob date default null,
  p_guardian_signature_image text default null,
  p_guardian_date date default null
)
returns uuid
language plpgsql
security definer
set search_path = wv, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into wv.waiver_signatures (
    name, email, signed_date, signature_image,
    dob, phone, address, city, state, zip,
    minor_info, guardian_print_name, guardian_dob, guardian_signature_image, guardian_date
  )
  values (
    p_name, p_email, p_signed_date, p_signature_image,
    p_dob, p_phone, p_address, p_city, p_state, p_zip,
    p_minor_info, p_guardian_print_name, p_guardian_dob, p_guardian_signature_image, p_guardian_date
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.submit_waiver_signature(
  text, text, date, text, date, text, text, text, text, text, text, text, date, text, date
) from public;
grant execute on function public.submit_waiver_signature(
  text, text, date, text, date, text, text, text, text, text, text, text, date, text, date
) to anon, authenticated;
