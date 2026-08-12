-- Confirm accounts that were created while "Confirm email" was still switched on.
--
-- Turning that setting off in Supabase → Authentication → Sign In / Providers →
-- Email only changes what happens to *new* sign-ups. Accounts created before the
-- change keep email_confirmed_at = null, and signing in with them fails with
-- "Email not confirmed". This marks them confirmed.
--
-- Run in Supabase → SQL Editor. Safe to run more than once.
--
-- Only do this for accounts you know are yours. Marking an address confirmed
-- means whoever holds the password owns it, with no proof they own the mailbox.

-- 1. Look first: which accounts are unconfirmed?
select id, email, created_at
from auth.users
where email_confirmed_at is null
order by created_at desc;

-- 2. Confirm one specific address — put yours here and run just this statement.
update auth.users
set email_confirmed_at = now()
where email = 'm.jassim@4flow.com'
  and email_confirmed_at is null;

-- 3. Or confirm every unconfirmed account in the project. Only sensible on a
--    project that is yours alone. Uncomment to use.
-- update auth.users
-- set email_confirmed_at = now()
-- where email_confirmed_at is null;

-- 4. Check it worked — email_confirmed_at should no longer be null.
select email, email_confirmed_at
from auth.users
order by created_at desc
limit 10;
