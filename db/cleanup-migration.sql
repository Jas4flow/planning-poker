-- Planning Poker · Cleanup Migration
--
-- This migration adds a cleanup job that deletes rooms older than 30 days
-- Run this once in Supabase → SQL Editor → New query → Run.
--
-- It is idempotent: running it again is safe.

-- ============================================================
-- Helper function to clean up old completed rooms
-- ============================================================

create or replace function public.pp_cleanup_old_rooms(days_to_keep int default 30)
returns table(deleted_count int, deleted_rooms text[])
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutoff_date timestamptz;
  v_deleted_ids text[];
  v_count int;
begin
  -- Calculate cutoff date (30 days ago by default)
  v_cutoff_date := now() - (days_to_keep || ' days')::interval;
  
  -- Get all rooms to be deleted for logging
  select array_agg(r.id || ' (' || r.name || ')')
  into v_deleted_ids
  from public.pp_rooms r
  where r.updated_at < v_cutoff_date;
  
  -- Delete rooms older than cutoff date
  -- Cascade will automatically delete pp_room_members entries
  -- Does NOT delete pp_profiles or user auth data
  delete from public.pp_rooms
  where updated_at < v_cutoff_date;
  
  get diagnostics v_count = row_count;
  
  return query select v_count, coalesce(v_deleted_ids, array[]::text[]);
end;
$$;

-- Grant execute permission to authenticated users (optional)
-- grant execute on function public.pp_cleanup_old_rooms to authenticated;

-- ============================================================
-- Optional: Extension for native Supabase cron jobs
-- ============================================================
-- To schedule automatic cleanup, use Supabase Database Webhooks or Cloud Functions:
--
-- 1. Via Supabase Cron Job (if pg_cron is enabled):
--    create extension if not exists pg_cron;
--    
--    select cron.schedule(
--      'pp_cleanup_old_rooms',
--      '0 2 * * *', -- 2 AM UTC every day
--      'select public.pp_cleanup_old_rooms(30)'
--    );
--
-- 2. Via Node.js background service (recommended):
--    See cleanup.mjs for the Node-based background service
--    This gives you better logging, error handling, and control.

comment on function public.pp_cleanup_old_rooms(int) is
'Deletes planning poker rooms not updated within the specified number of days. 
Does NOT delete user profiles or authentication data.
Cascade delete automatically removes associated room_members entries.
Safe to run multiple times.';
