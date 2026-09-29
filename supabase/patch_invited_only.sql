-- GRADQUIZ patch: Invited only quizzes with an email code.
-- Run once in the Supabase SQL Editor. Safe to run again.
-- A quiz is either open (anyone with the code) or invited (only emails on its list, and the student
-- must type a 6 digit code sent to that email before starting).
-- The code is made here and emailed by the Netlify function send-otp. It is stored only as a salted hash.

-- ---------- columns and tables ----------

alter table public.quizzes add column if not exists access text not null default 'open';
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.quizzes'::regclass and conname = 'quizzes_access_check') then
    alter table public.quizzes add constraint quizzes_access_check check (access in ('open', 'invited'));
  end if;
end $$;

create table if not exists public.quiz_invites (
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  created_at timestamptz not null default now(),
  primary key (quiz_id, email)
);

create table if not exists public.quiz_otps (
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  email text not null,
  salt text not null,
  code_hash text not null,
  sent_at timestamptz not null default now(),
  expires_at timestamptz not null,
  tries int not null default 0,
  primary key (quiz_id, email)
);

alter table public.quiz_invites enable row level security;
alter table public.quiz_otps    enable row level security;

drop policy if exists quiz_invites_admin on public.quiz_invites;
create policy quiz_invites_admin on public.quiz_invites for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
-- quiz_otps has no policies on purpose. Only the functions below touch it.

-- ---------- quiz_info now says whether the quiz is invited only ----------

create or replace function public.quiz_info(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare q quizzes%rowtype; n int; t int;
begin
  select * into q from quizzes where code = upper(trim(p_code));
  if not found then return jsonb_build_object('found', false); end if;
  select count(*), count(*) filter (where kind = 'tita') into n, t from questions where quiz_id = q.id;
  return jsonb_build_object(
    'found', true,
    'title', q.title,
    'instructions', q.instructions,
    'status', q.status,
    'access', q.access,
    'duration_minutes', q.duration_minutes,
    'marks_correct', q.marks_correct,
    'marks_wrong', q.marks_wrong,
    'marks_wrong_tita', q.marks_wrong_tita,
    'question_count', n,
    'tita_count', t);
end $$;

-- ---------- make a code (called only by the Netlify function with the service key) ----------

create or replace function public.issue_quiz_otp(p_code text, p_email text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  q quizzes%rowtype;
  v_email text := lower(btrim(coalesce(p_email, '')));
  o quiz_otps%rowtype;
  v_otp text;
  v_salt text := gen_random_uuid()::text;
begin
  select * into q from quizzes where code = upper(btrim(coalesce(p_code, '')));
  if not found then return jsonb_build_object('ok', false, 'reason', 'QUIZ_NOT_FOUND'); end if;
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

  -- 6 digits from a secure random source
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

-- ---------- start_attempt checks the list and the code on invited quizzes ----------
-- A wrong code is returned as {"error": "BAD_OTP"} instead of raised, so the try count is saved.

drop function if exists public.start_attempt(text, text, text);
drop function if exists public.start_attempt(text, text, text, text);

-- a newer start_attempt (patch_device.sql) takes one more argument; remove it so there is only one. Run patch_device.sql again after this if you use device codes.
drop function if exists public.start_attempt(text, text, text, text, text, text);

create or replace function public.start_attempt(p_code text, p_name text, p_email text, p_pin text default null, p_otp text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  q quizzes%rowtype; v_name text; v_email text; v_id uuid; v_token uuid;
  v_pin text := nullif(btrim(coalesce(p_pin, '')), '');
  v_salt text; v_hash text;
  o quiz_otps%rowtype;
begin
  v_name := trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_email := lower(trim(coalesce(p_email, '')));
  if length(v_name) < 2 or length(v_name) > 80 then raise exception 'BAD_NAME'; end if;
  if length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'BAD_EMAIL'; end if;
  if v_pin is not null and v_pin !~ '^[0-9]{4,6}$' then raise exception 'BAD_PIN'; end if;

  select * into q from quizzes where code = upper(trim(p_code));
  if not found then raise exception 'QUIZ_NOT_FOUND'; end if;
  if q.status = 'draft' then raise exception 'QUIZ_NOT_STARTED'; end if;
  if q.status = 'ended' then raise exception 'QUIZ_ENDED'; end if;

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

  return _state_json(v_id) || jsonb_build_object('token', v_token);
end $$;

grant execute on function public.start_attempt(text, text, text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
