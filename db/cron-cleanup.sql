-- Planning Poker · Scheduled Cleanup (pg_cron)
--
-- Adds automatic, recurring cleanup on top of db/cleanup-migration.sql.
-- Run db/cleanup-migration.sql FIRST (it creates public.pp_cleanup_old_rooms).
-- Then run this file once in Supabase → SQL Editor → New query → Run.
-- Idempotent: running it again just reschedules the same job.

create extension if not exists pg_cron;

-- pg_cron runs as postgres, so the schedule function needs access to call
-- the definer function. Unschedule first so re-running this file doesn't
-- create duplicate jobs with the same name.
select cron.unschedule(jobid)
from cron.job
where jobname = 'pp_cleanup_old_rooms';

-- Every 24 hours at 02:00 UTC, delete rooms whose state hasn't changed in
-- 30+ days. Cascade removes the matching pp_room_members rows; pp_profiles
-- and auth.users are never touched (see pp_cleanup_old_rooms definition).
select cron.schedule(
  'pp_cleanup_old_rooms',
  '0 2 * * *',
  $$select public.pp_cleanup_old_rooms(30)$$
);

-- Verify the job is registered:
-- select jobid, jobname, schedule, active from cron.job where jobname = 'pp_cleanup_old_rooms';

-- Verify it's running:
-- select * from cron.job_run_details
-- where jobid = (select jobid from cron.job where jobname = 'pp_cleanup_old_rooms')
-- order by start_time desc limit 5;

-- To stop the schedule later:
-- select cron.unschedule('pp_cleanup_old_rooms');
