-- GRADQUIZ fix: email codes and Reset PIN failed with "function gen_random_bytes(integer) does not exist".
-- On Supabase that function lives in the extensions schema, which these functions do not search.
-- The random digits now come from gen_random_uuid(), which is built into Postgres. Run once in the SQL Editor.

create or replace function public.issue_quiz_otp(p_code text, p_email text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  q quizzes%rowtype;
  v_email text := lower(btrim(coalesce(p_email, '')));
  o quiz_otps%rowtype;
  v_otp text;
  v_salt text := gen_random_uuid()::text;
  v_id uuid;
begin
  select id into v_id from quizzes where code = upper(btrim(coalesce(p_code, '')));
  if not found then return jsonb_build_object('ok', false, 'reason', 'QUIZ_NOT_FOUND'); end if;
  perform _apply_schedule(v_id);
  select * into q from quizzes where id = v_id;
  if q.status = 'draft' then return jsonb_build_object('ok', false, 'reason', 'QUIZ_NOT_STARTED'); end if;
  if q.status = 'ended' then return jsonb_build_object('ok', false, 'reason', 'QUIZ_ENDED'); end if;
  if q.access <> 'invited' then return jsonb_build_object('ok', false, 'reason', 'NOT_NEEDED'); end if;
  if not exists (select 1 from quiz_invites where quiz_id = q.id and email = v_email) then
    return jsonb_build_object('ok', false, 'reason', 'NOT_INVITED');
  end if;
  if exists (select 1 from attempts where quiz_id = q.id and lower(email) = v_email) then
    return jsonb_build_object('ok', false, 'reason', 'ALREADY_ATTEMPTED');
  end if;

  select * into o from quiz_otps where quiz_id = q.id and email = v_email for update;
  if found and o.sent_at > now() - interval '60 seconds' then
    return jsonb_build_object('ok', false, 'reason', 'OTP_WAIT',
      'wait', ceil(extract(epoch from (o.sent_at + interval '60 seconds' - now())))::int);
  end if;

  v_otp := lpad(((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint) % 1000000)::text, 6, '0');

  insert into quiz_otps (quiz_id, email, salt, code_hash, sent_at, expires_at, tries)
  values (q.id, v_email, v_salt, _pin_hash(v_salt, v_otp), now(), now() + interval '10 minutes', 0)
  on conflict (quiz_id, email) do update
    set salt = excluded.salt, code_hash = excluded.code_hash, sent_at = excluded.sent_at,
        expires_at = excluded.expires_at, tries = 0;

  return jsonb_build_object('ok', true, 'otp', v_otp, 'title', q.title);
end $$;

revoke all on function public.issue_quiz_otp(text, text) from public, anon, authenticated;
grant execute on function public.issue_quiz_otp(text, text) to service_role;

-- Gives the student a new 4 digit PIN and returns it once so the admin can tell them.
-- Also clears a lockout and any "asked for help" flag.
create or replace function public.admin_reset_pin(p_attempt uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_pin text; v_salt text := gen_random_uuid()::text;
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  if not exists (select 1 from attempts where id = p_attempt) then raise exception 'INVALID_ATTEMPT'; end if;
  v_pin := lpad(((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint) % 10000)::text, 4, '0');
  update attempts
  set pin_salt = v_salt, pin_hash = _pin_hash(v_salt, v_pin), pin_fails = 0, pin_locked_until = null, link_requested_at = null
  where id = p_attempt;
  return v_pin;
end $$;

revoke all on function public.admin_reset_pin(uuid) from public, anon;
grant execute on function public.admin_reset_pin(uuid) to authenticated;

notify pgrst, 'reload schema';
