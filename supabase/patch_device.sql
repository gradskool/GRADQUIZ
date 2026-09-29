-- GRADQUIZ patch: email code once per device for listed-students programs (like LRDI).
-- Run once in the Supabase SQL Editor, after patch_sets.sql. Safe to run again.
-- Turn it on per program under Admin > Programs. The first time a student starts a quiz of that program on a
-- phone or laptop, a 6 digit code is emailed (same Gmail setup as Invited only). That device is then trusted
-- for that email for 60 days, so someone who only knows another student's email cannot start as them.

alter table public.programs add column if not exists verify_device boolean not null default false;

create table if not exists public.trusted_devices (
  token_hash text primary key,
  email text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz not null
);
create index if not exists trusted_devices_email on public.trusted_devices (email);
alter table public.trusted_devices enable row level security;
drop policy if exists trusted_devices_admin on public.trusted_devices;
create policy trusted_devices_admin on public.trusted_devices for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- only a hash of the device secret is stored
create or replace function public._device_hash(p text) returns text
language sql immutable as $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;

-- removing a student from a program forgets their devices too
create or replace function public._forget_devices() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from program_members m where m.email = old.email) then
    delete from trusted_devices where email = old.email;
  end if;
  return old;
end $$;
drop trigger if exists program_members_forget on public.program_members;
create trigger program_members_forget after delete on public.program_members
  for each row execute function public._forget_devices();

create or replace function public.quiz_info(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare q quizzes%rowtype; n int; t int; v_id uuid;
begin
  select id into v_id from quizzes where code = upper(trim(p_code));
  if not found then return jsonb_build_object('found', false); end if;
  perform _apply_schedule(v_id);
  select * into q from quizzes where id = v_id;
  select count(*), count(*) filter (where kind = 'tita') into n, t from questions where quiz_id = q.id;
  return jsonb_build_object(
    'found', true,
    'title', q.title,
    'instructions', q.instructions,
    'status', q.status,
    'access', q.access,
    'starts_at', case when q.status = 'draft' then q.starts_at end,
    'ends_at', case when q.status <> 'ended' then q.ends_at end,
    'server_now', now(),
    'practice', false,
    'program', q.program,
    'roster_only', coalesce((select p.roster_only from programs p where p.name = q.program), false),
    -- listed-students programs can ask for an email code once per device
    'verify_device', q.access <> 'invited' and coalesce((select p.roster_only and p.verify_device from programs p where p.name = q.program), false),
    'duration_minutes', q.duration_minutes,
    'marks_correct', q.marks_correct,
    'marks_wrong', q.marks_wrong,
    'marks_wrong_tita', q.marks_wrong_tita,
    'question_count', n,
    'tita_count', t);
end $$;

drop function if exists public.start_attempt(text, text, text, text, text);

create or replace function public.start_attempt(p_code text, p_name text, p_email text, p_pin text default null, p_otp text default null, p_device text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  q quizzes%rowtype; v_name text; v_email text; v_id uuid; v_token uuid; v_quiz uuid;
  v_pin text := nullif(btrim(coalesce(p_pin, '')), '');
  v_salt text; v_hash text;
  o quiz_otps%rowtype;
  v_verify boolean;
  v_dev text := nullif(btrim(coalesce(p_device, '')), '');
  v_newdev text;
begin
  v_name := trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_email := lower(trim(coalesce(p_email, '')));
  if length(v_name) < 2 or length(v_name) > 80 then raise exception 'BAD_NAME'; end if;
  if length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'BAD_EMAIL'; end if;
  if v_pin is not null and v_pin !~ '^[0-9]{4,6}$' then raise exception 'BAD_PIN'; end if;

  select id into v_quiz from quizzes where code = upper(trim(p_code));
  if not found then raise exception 'QUIZ_NOT_FOUND'; end if;
  perform _apply_schedule(v_quiz);
  select * into q from quizzes where id = v_quiz;
  if q.status = 'draft' then raise exception 'QUIZ_NOT_STARTED'; end if;
  if q.status = 'ended' then raise exception 'QUIZ_ENDED'; end if;

  -- roster programs (like LRDI): only emails on the program's list may start
  if exists (select 1 from programs p where p.name = q.program and p.roster_only)
     and not exists (select 1 from program_members m where m.program = q.program and m.email = v_email) then
    raise exception 'NOT_IN_PROGRAM';
  end if;

  -- email code once per device: a trusted device for this email goes straight in, otherwise the emailed code
  -- proves the email is theirs and this device is remembered for 60 days
  v_verify := q.access <> 'invited' and coalesce((select p.roster_only and p.verify_device from programs p where p.name = q.program), false);
  if v_verify then
    if v_dev is not null and exists (select 1 from trusted_devices d where d.token_hash = _device_hash(v_dev) and d.email = v_email and d.expires_at > now()) then
      update trusted_devices set last_used_at = now() where token_hash = _device_hash(v_dev);
    else
      if nullif(btrim(coalesce(p_otp, '')), '') is null then return jsonb_build_object('error', 'NEED_CODE'); end if;
      select * into o from quiz_otps where quiz_id = q.id and email = v_email for update;
      if not found then return jsonb_build_object('error', 'OTP_MISSING'); end if;
      if o.expires_at <= now() then return jsonb_build_object('error', 'OTP_EXPIRED'); end if;
      if o.tries >= 5 then return jsonb_build_object('error', 'OTP_LOCKED'); end if;
      if _pin_hash(o.salt, btrim(coalesce(p_otp, ''))) <> o.code_hash then
        update quiz_otps set tries = tries + 1 where quiz_id = q.id and email = v_email;
        return jsonb_build_object('error', case when o.tries + 1 >= 5 then 'OTP_LOCKED' else 'BAD_OTP' end);
      end if;
      v_newdev := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
      insert into trusted_devices (token_hash, email, expires_at) values (_device_hash(v_newdev), v_email, now() + interval '60 days');
    end if;
  end if;

  if q.access = 'invited' then
    if not exists (select 1 from quiz_invites where quiz_id = q.id and email = v_email) then
      raise exception 'NOT_INVITED';
    end if;
    select * into o from quiz_otps where quiz_id = q.id and email = v_email for update;
    if not found then return jsonb_build_object('error', 'OTP_MISSING'); end if;
    if o.expires_at <= now() then return jsonb_build_object('error', 'OTP_EXPIRED'); end if;
    if o.tries >= 5 then return jsonb_build_object('error', 'OTP_LOCKED'); end if;
    if _pin_hash(o.salt, btrim(coalesce(p_otp, ''))) <> o.code_hash then
      update quiz_otps set tries = tries + 1 where quiz_id = q.id and email = v_email;
      return jsonb_build_object('error', case when o.tries + 1 >= 5 then 'OTP_LOCKED' else 'BAD_OTP' end);
    end if;
  end if;

  if v_pin is not null then
    v_salt := gen_random_uuid()::text;
    v_hash := _pin_hash(v_salt, v_pin);
  end if;

  insert into attempts (quiz_id, name, email, deadline, pin_salt, pin_hash)
  values (q.id, v_name, v_email, now() + make_interval(mins => q.duration_minutes), v_salt, v_hash)
  on conflict do nothing
  returning id, token into v_id, v_token;

  if v_id is null then raise exception 'ALREADY_ATTEMPTED'; end if;

  delete from quiz_otps where quiz_id = q.id and email = v_email;

  return _state_json(v_id) || jsonb_build_object('token', v_token)
    || case when v_newdev is not null then jsonb_build_object('device_token', v_newdev) else '{}'::jsonb end;
end $$;

grant execute on function public.start_attempt(text, text, text, text, text, text) to anon, authenticated;

create or replace function public.issue_quiz_otp(p_code text, p_email text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  q quizzes%rowtype;
  v_email text := lower(btrim(coalesce(p_email, '')));
  o quiz_otps%rowtype;
  v_otp text;
  v_salt text := gen_random_uuid()::text;
  v_id uuid;
  v_verify boolean;
begin
  select id into v_id from quizzes where code = upper(btrim(coalesce(p_code, '')));
  if not found then return jsonb_build_object('ok', false, 'reason', 'QUIZ_NOT_FOUND'); end if;
  perform _apply_schedule(v_id);
  select * into q from quizzes where id = v_id;
  if q.status = 'draft' then return jsonb_build_object('ok', false, 'reason', 'QUIZ_NOT_STARTED'); end if;
  if q.status = 'ended' then return jsonb_build_object('ok', false, 'reason', 'QUIZ_ENDED'); end if;
  v_verify := q.access <> 'invited' and coalesce((select p.roster_only and p.verify_device from programs p where p.name = q.program), false);
  if q.access <> 'invited' and not v_verify then return jsonb_build_object('ok', false, 'reason', 'NOT_NEEDED'); end if;
  if exists (select 1 from programs p where p.name = q.program and p.roster_only)
     and not exists (select 1 from program_members m where m.program = q.program and m.email = v_email) then
    return jsonb_build_object('ok', false, 'reason', 'NOT_IN_PROGRAM');
  end if;
  if not v_verify and not exists (select 1 from quiz_invites where quiz_id = q.id and email = v_email) then
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

notify pgrst, 'reload schema';
