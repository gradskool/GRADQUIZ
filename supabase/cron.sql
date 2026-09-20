-- GRADQUIZ scheduled job. Run once, after schema.sql.
-- Every minute it closes attempts whose timer ran out.
-- Enable pg_cron first if this errors. Supabase dashboard > Database > Extensions > pg_cron.

create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
               'gradquiz-close-expired',
               '* * * * *',
               $$ select public.close_expired_attempts(); $$
);

-- To stop it later
-- select cron.unschedule('gradquiz-close-expired');