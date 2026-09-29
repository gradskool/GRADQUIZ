-- GRADQUIZ patch: programs (FYQ, LRDI). Run once in the Supabase SQL Editor. Safe to run again.
-- Every quiz belongs to a program. FYQ is open (anyone with the code). LRDI is roster only:
-- only emails on its list can start its quizzes, and nobody can add themselves.
-- Students see only their own programs in the library: every roster they are on,
-- plus any open program they have attempted a quiz in.

create table if not exists public.programs (
  name text primary key check (length(name) between 1 and 40),
  roster_only boolean not null default false,
  created_at timestamptz not null default now()
);
insert into public.programs (name, roster_only) values ('FYQ', false), ('LRDI', true) on conflict (name) do nothing;

create table if not exists public.program_members (
  program text not null references public.programs(name) on update cascade on delete cascade,
  email text not null check (email = lower(btrim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  created_at timestamptz not null default now(),
  primary key (program, email)
);
create index if not exists program_members_email on public.program_members (email);

alter table public.quizzes add column if not exists program text not null default 'FYQ';
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.quizzes'::regclass and conname = 'quizzes_program_fkey') then
    alter table public.quizzes add constraint quizzes_program_fkey foreign key (program) references public.programs(name) on update cascade;
  end if;
end $$;

alter table public.programs enable row level security;
alter table public.program_members enable row level security;
drop policy if exists programs_admin on public.programs;
create policy programs_admin on public.programs for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists program_members_admin on public.program_members;
create policy program_members_admin on public.program_members for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- starting a quiz checks the roster ----------

-- a newer start_attempt (patch_device.sql) takes one more argument; remove it so there is only one. Run patch_device.sql again after this if you use device codes.
drop function if exists public.start_attempt(text, text, text, text, text, text);

create or replace function public.start_attempt(p_code text, p_name text, p_email text, p_pin text default null, p_otp text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  q quizzes%rowtype; v_name text; v_email text; v_id uuid; v_token uuid; v_quiz uuid;
  v_pin text := nullif(btrim(coalesce(p_pin, '')), '');
  v_salt text; v_hash text;
  o quiz_otps%rowtype;
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
  if exists (select 1 from programs p where p.name = q.program and p.roster_only)
     and not exists (select 1 from program_members m where m.program = q.program and m.email = v_email) then
    return jsonb_build_object('ok', false, 'reason', 'NOT_IN_PROGRAM');
  end if;
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

-- ---------- the quiz page knows the program ----------

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
    'duration_minutes', q.duration_minutes,
    'marks_correct', q.marks_correct,
    'marks_wrong', q.marks_wrong,
    'marks_wrong_tita', q.marks_wrong_tita,
    'question_count', n,
    'tita_count', t);
end $$;

-- ---------- the library shows only the student's programs ----------

create or replace function public.my_library(p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_emails text[]; v_batches text[];
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 300 then
    return jsonb_build_object('emails', '[]'::jsonb, 'quizzes', '[]'::jsonb);
  end if;

  perform _apply_schedules();

  -- who is this: every email with a matching attempt secret
  select array_agg(distinct lower(a.email)) into v_emails
  from attempts a
  join (
    select case when (e ->> 'a') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (e ->> 'a')::uuid end as a,
           case when (e ->> 't') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (e ->> 't')::uuid end as t
    from jsonb_array_elements(p_items) e where jsonb_typeof(e) = 'object'
  ) p on a.id = p.a and a.token = p.t;

  if v_emails is null then
    return jsonb_build_object('emails', '[]'::jsonb, 'quizzes', '[]'::jsonb);
  end if;

  -- their batches: any batch of a quiz they attempted
  select array_agg(distinct lower(z.batch)) into v_batches
  from attempts a join quizzes z on z.id = a.quiz_id
  where lower(a.email) = any (v_emails) and z.batch is not null;

  return jsonb_build_object(
    'emails', to_jsonb(v_emails),
    'quizzes', coalesce((
      select jsonb_agg(jsonb_build_object(
          'code', z.code, 'title', z.title, 'program', z.program,
          'batch', z.batch, 'topic', coalesce(z.topic, 'Other'),
          'status', z.status,
          'starts_at', case when z.status = 'draft' then z.starts_at end,
          'ends_at', case when z.status = 'live' then z.ends_at end,
          'opened_at', coalesce(z.started_at, z.starts_at, z.created_at),
          'duration_minutes', z.duration_minutes,
          'question_count', (select count(*) from questions x where x.quiz_id = z.id),
          'practice', z.allow_practice,
          'mine', (
            select jsonb_build_object(
              'status', m.status,
              'submitted_at', m.submitted_at,
              'score', case when z.show_score then m.score end,
              'total_marks', case when z.show_score then (select count(*) from questions x where x.quiz_id = z.id) * z.marks_correct end,
              'rank', case when z.show_score and m.status = 'submitted' then 1 + (select count(*) from attempts o where o.quiz_id = z.id and o.status = 'submitted' and o.score > m.score) end,
              'of', case when z.show_score and m.status = 'submitted' then (select count(*) from attempts o where o.quiz_id = z.id and o.status = 'submitted' and o.score is not null) end,
              'percentile', case when z.show_score and m.status = 'submitted' then round(100.0 *
                  (select count(*) from attempts o where o.quiz_id = z.id and o.status = 'submitted' and o.score <= m.score) /
                  nullif((select count(*) from attempts o where o.quiz_id = z.id and o.status = 'submitted' and o.score is not null), 0), 2) end)
            from attempts m where m.quiz_id = z.id and lower(m.email) = any (v_emails)
            order by m.started_at desc limit 1))
        order by coalesce(z.started_at, z.starts_at, z.created_at) desc)
      from quizzes z
      where z.in_library and z.batch is not null
        -- their programs: any roster they are on, plus any open program they have attempted in
        and (z.program in (select m.program from program_members m where m.email = any (v_emails))
             or (not coalesce((select p.roster_only from programs p where p.name = z.program), false)
                 and z.program in (select y.program from attempts a2 join quizzes y on y.id = a2.quiz_id
                                   where lower(a2.email) = any (v_emails))))
        and (z.status in ('live', 'ended') or (z.status = 'draft' and z.starts_at is not null))
        and (z.access = 'open'
             or exists (select 1 from quiz_invites i where i.quiz_id = z.id and i.email = any (v_emails))
             or exists (select 1 from attempts m where m.quiz_id = z.id and lower(m.email) = any (v_emails)))
    ), '[]'::jsonb));
end $$;

grant execute on function public.my_library(jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
