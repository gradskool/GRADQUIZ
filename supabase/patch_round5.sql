-- GRADQUIZ patch, round 5. Run once in the Supabase SQL Editor. Safe to run again.
-- 1. Reopen an ended quiz from the admin page.
-- 2. Admin resets a student's PIN (replaces sending personal links).

create or replace function public.set_quiz_status(p_quiz uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare q quizzes%rowtype;
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  select * into q from quizzes where id = p_quiz for update;
  if not found then raise exception 'QUIZ_NOT_FOUND'; end if;

  if p_status = 'live' and q.status = 'draft' then
    if not exists (select 1 from questions where quiz_id = p_quiz) then raise exception 'NO_QUESTIONS'; end if;
    update quizzes set status = 'live', started_at = now() where id = p_quiz;
  elsif p_status = 'ended' and q.status = 'live' then
    -- no new students can start. Anyone already working keeps their own timer and can finish.
    update quizzes set status = 'ended', ended_at = now() where id = p_quiz;
  elsif p_status = 'live' and q.status = 'ended' then
    -- reopen: new students can start again. A past close-entry time is cleared so it does not end straight away.
    update quizzes set status = 'live', ended_at = null, ends_at = null where id = p_quiz;
  else
    raise exception 'BAD_TRANSITION';
  end if;
end $$;

revoke all on function public.set_quiz_status(uuid, text) from public, anon;
grant execute on function public.set_quiz_status(uuid, text) to authenticated;

-- Gives the student a new 4 digit PIN and returns it once so the admin can tell them.
-- Also clears a lockout and any "asked for help" flag.
create or replace function public.admin_reset_pin(p_attempt uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_pin text; v_salt text := gen_random_uuid()::text;
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  if not exists (select 1 from attempts where id = p_attempt) then raise exception 'INVALID_ATTEMPT'; end if;
  v_pin := lpad(((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 10000)::text, 4, '0');
  update attempts
  set pin_salt = v_salt, pin_hash = _pin_hash(v_salt, v_pin), pin_fails = 0, pin_locked_until = null, link_requested_at = null
  where id = p_attempt;
  return v_pin;
end $$;

revoke all on function public.admin_reset_pin(uuid) from public, anon;
grant execute on function public.admin_reset_pin(uuid) to authenticated;

notify pgrst, 'reload schema';
