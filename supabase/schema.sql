-- GRADQUIZ schema for Supabase. Safe to run again on an existing project, it upgrades in place.
-- v2 adds type-in (TITA) questions. v3 adds answer review and explanations. v4 adds a PIN so students can find their result again. Ending a quiz only stops new entries, anyone already working can finish. Run cron.sql after this to auto-close timed-out attempts.
-- Students never touch tables. They only call the functions at the bottom.
-- Answer keys stay on the server. Scoring and timing are done on the server.

create extension if not exists pgcrypto;

-- ---------- tables ----------

create table if not exists public.admins (
                                             user_id uuid primary key references auth.users(id) on delete cascade
    );

create table if not exists public.quizzes (
                                              id uuid primary key default gen_random_uuid(),
    code text not null unique check (code ~ '^[A-Z0-9]{4,12}$'),
    title text not null,
    instructions text,
    status text not null default 'draft' check (status in ('draft','live','ended')),
    duration_minutes int not null default 30 check (duration_minutes between 1 and 600),
    marks_correct numeric not null default 3 check (marks_correct >= 0),
    marks_wrong numeric not null default 1 check (marks_wrong >= 0),
    marks_wrong_tita numeric not null default 0 check (marks_wrong_tita >= 0),
    show_score boolean not null default true,
    show_review boolean not null default false,
    created_at timestamptz not null default now(),
    started_at timestamptz,
    ended_at timestamptz
    );

create table if not exists public.questions (
                                                id uuid primary key default gen_random_uuid(),
    quiz_id uuid not null references public.quizzes(id) on delete cascade,
    position int not null,
    kind text not null default 'mcq' check (kind in ('mcq','tita')),
    body text not null,
    options jsonb not null default '[]'::jsonb,
    correct_index int,
    accepted text[],
    explanation text,
    created_at timestamptz not null default now(),
    constraint questions_shape check (
    (kind = 'mcq'
     and jsonb_typeof(options) = 'array'
    and (case when jsonb_typeof(options) = 'array' then jsonb_array_length(options) else -1 end) between 2 and 6
    and correct_index is not null and correct_index >= 0
    and correct_index < (case when jsonb_typeof(options) = 'array' then jsonb_array_length(options) else -1 end)
    and accepted is null)
    or
(kind = 'tita'
 and options = '[]'::jsonb
 and correct_index is null
 and accepted is not null and cardinality(accepted) between 1 and 10
    and array_position(accepted, ''::text) is null)
    )
    );
create index if not exists questions_quiz_pos on public.questions (quiz_id, position);

create table if not exists public.attempts (
                                               id uuid primary key default gen_random_uuid(),
    quiz_id uuid not null references public.quizzes(id) on delete cascade,
    name text not null,
    email text not null,
    token uuid not null default gen_random_uuid(),
    started_at timestamptz not null default now(),
    deadline timestamptz not null,
    submitted_at timestamptz,
    status text not null default 'in_progress' check (status in ('in_progress','submitted')),
    submit_reason text check (submit_reason in ('manual','time','ended')),
    answers jsonb not null default '{}'::jsonb,
    graded jsonb not null default '{}'::jsonb,
    pin_salt text,
    pin_hash text,
    pin_fails int not null default 0,
    pin_locked_until timestamptz,
    correct int,
    wrong int,
    unattempted int,
    score numeric,
    time_taken_seconds int
    );
create unique index if not exists attempts_one_per_email on public.attempts (quiz_id, lower(email));
create index if not exists attempts_quiz on public.attempts (quiz_id);


-- ---------- upgrade from v1 (does nothing on a fresh install) ----------

alter table public.quizzes   add column if not exists marks_wrong_tita numeric not null default 0;
alter table public.questions add column if not exists kind text not null default 'mcq';
alter table public.questions add column if not exists accepted text[];
alter table public.attempts  add column if not exists graded jsonb not null default '{}'::jsonb;
alter table public.attempts  add column if not exists pin_salt text;
alter table public.attempts  add column if not exists pin_hash text;
alter table public.attempts  add column if not exists pin_fails int not null default 0;
alter table public.attempts  add column if not exists pin_locked_until timestamptz;
alter table public.quizzes   add column if not exists show_review boolean not null default false;
alter table public.questions add column if not exists explanation text;
alter table public.questions alter column correct_index drop not null;
alter table public.questions alter column options set default '[]'::jsonb;

do $$
declare c record;
begin
  -- v1 shape checks on options and correct_index are replaced by questions_shape
for c in
select conname from pg_constraint
where conrelid = 'public.questions'::regclass and contype = 'c' and conname <> 'questions_shape'
      and (pg_get_constraintdef(oid) ilike '%options%' or pg_get_constraintdef(oid) ilike '%correct_index%')
  loop
    execute format('alter table public.questions drop constraint %I', c.conname);
end loop;

  if not exists (select 1 from pg_constraint where conrelid = 'public.questions'::regclass and conname = 'questions_kind_check') then
alter table public.questions add constraint questions_kind_check check (kind in ('mcq','tita'));
end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.quizzes'::regclass and conname = 'quizzes_marks_wrong_tita_check') then
alter table public.quizzes add constraint quizzes_marks_wrong_tita_check check (marks_wrong_tita >= 0);
end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.questions'::regclass and conname = 'questions_shape') then
alter table public.questions add constraint questions_shape check (
    (kind = 'mcq'
        and jsonb_typeof(options) = 'array'
        and (case when jsonb_typeof(options) = 'array' then jsonb_array_length(options) else -1 end) between 2 and 6
        and correct_index is not null and correct_index >= 0
        and correct_index < (case when jsonb_typeof(options) = 'array' then jsonb_array_length(options) else -1 end)
        and accepted is null)
        or
    (kind = 'tita'
        and options = '[]'::jsonb
        and correct_index is null
        and accepted is not null and cardinality(accepted) between 1 and 10
        and array_position(accepted, ''::text) is null));
end if;
end $$;

-- v1 attempts have no per-question grading yet. Fill it in once from the saved answers (all v1 questions were MCQ).
update public.attempts a set graded = coalesce((
                                                   select jsonb_object_agg(q.id::text, ((a.answers ->> q.id::text)::int = q.correct_index))
                                                   from public.questions q
                                                   where q.quiz_id = a.quiz_id and q.kind = 'mcq' and a.answers ? q.id::text), '{}'::jsonb)
where a.status = 'submitted' and a.graded = '{}'::jsonb and a.answers <> '{}'::jsonb;

-- ---------- admin check ----------

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- ---------- row level security (admins only) ----------

alter table public.admins    enable row level security;
alter table public.quizzes   enable row level security;
alter table public.questions enable row level security;
alter table public.attempts  enable row level security;

drop policy if exists admins_self on public.admins;
create policy admins_self on public.admins for select to authenticated using (user_id = auth.uid());

drop policy if exists quizzes_admin on public.quizzes;
create policy quizzes_admin on public.quizzes for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists questions_admin on public.questions;
create policy questions_admin on public.questions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists attempts_admin on public.attempts;
create policy attempts_admin on public.attempts for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------- guard rails ----------

-- Questions can only change while the quiz is a draft.
create or replace function public._lock_questions() returns trigger
language plpgsql security definer set search_path = public as $$
declare s text;
begin
select status into s from quizzes where id = coalesce(new.quiz_id, old.quiz_id);
if s is not null and s <> 'draft' then
    -- an explanation can still be written or fixed after the quiz starts, nothing else can change
    if tg_op = 'UPDATE' and
       (new.quiz_id, new.position, new.kind, new.body, new.options, new.correct_index, new.accepted)
       is not distinct from
       (old.quiz_id, old.position, old.kind, old.body, old.options, old.correct_index, old.accepted) then
      return new;
end if;
    raise exception 'QUIZ_LOCKED';
end if;
return coalesce(new, old);
end $$;

drop trigger if exists questions_lock on public.questions;
create trigger questions_lock before insert or update or delete on public.questions
    for each row execute function public._lock_questions();

-- Code, timer and marking lock once the quiz leaves draft.
create or replace function public._lock_quiz_settings() returns trigger
language plpgsql as $$
begin
  if old.status <> 'draft' and (
       new.code is distinct from old.code
    or new.duration_minutes is distinct from old.duration_minutes
    or new.marks_correct is distinct from old.marks_correct
    or new.marks_wrong is distinct from old.marks_wrong
    or new.marks_wrong_tita is distinct from old.marks_wrong_tita) then
    raise exception 'QUIZ_LOCKED';
end if;
return new;
end $$;

drop trigger if exists quizzes_lock on public.quizzes;
create trigger quizzes_lock before update on public.quizzes
    for each row execute function public._lock_quiz_settings();

-- ---------- internal helpers (not callable by students) ----------

-- PIN hashing. The PIN is never stored, only a salted hash of it.
create or replace function public._pin_hash(p_salt text, p_pin text) returns text
language sql immutable as $$
select encode(sha256(convert_to(p_salt || ':' || p_pin, 'UTF8')), 'hex');
$$;

create or replace function public._clean_answers(p_quiz uuid, p_answers jsonb) returns jsonb
language sql stable security definer set search_path = public as $$
select coalesce(jsonb_object_agg(
                        q.id::text,
                        case when q.kind = 'mcq' then to_jsonb((p_answers ->> q.id::text)::int)
                             else to_jsonb(left(btrim(p_answers ->> q.id::text), 40)) end), '{}'::jsonb)
from questions q
where q.quiz_id = p_quiz
  and case q.kind
          when 'mcq' then
              jsonb_typeof(p_answers -> q.id::text) = 'number'
                  and case when (p_answers ->> q.id::text) ~ '^[0-9]{1,2}$'
                     then (p_answers ->> q.id::text)::int < jsonb_array_length(q.options)
                     else false end
          else
            jsonb_typeof(p_answers -> q.id::text) = 'string'
            and btrim(p_answers ->> q.id::text) <> ''
end;
$$;

-- Reads a typed answer as a number when it looks like one. 1,000 and 1000.0 and +1000 all read as 1000.
create or replace function public._norm_num(t text) returns numeric
language plpgsql immutable as $$
begin
  t := replace(replace(btrim(coalesce(t, '')), ',', ''), ' ', '');
  if length(t) between 1 and 30 and t ~ '^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)$' then
    return t::numeric;
end if;
return null;
end $$;

-- Numbers match as numbers. Anything else matches ignoring case and extra spaces.
create or replace function public._tita_match(given text, accepted text[]) returns boolean
language plpgsql immutable as $$
declare a text; g numeric := public._norm_num(given); n numeric;
begin
  foreach a in array accepted loop
    n := public._norm_num(a);
    if g is not null and n is not null then
      if g = n then return true; end if;
    elsif lower(btrim(regexp_replace(given, '\s+', ' ', 'g'))) = lower(btrim(regexp_replace(a, '\s+', ' ', 'g'))) then
      return true;
end if;
end loop;
return false;
end $$;

create or replace function public._finalize_attempt(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
a attempts%rowtype;
  q quizzes%rowtype;
  r record;
  ok boolean;
  c int := 0; wm int := 0; wt int := 0; u int := 0;
  g jsonb := '{}'::jsonb;
  finished timestamptz;
begin
select * into a from attempts where id = p_id for update;
if not found or a.status = 'submitted' then return; end if;
select * into q from quizzes where id = a.quiz_id;

for r in select id, kind, correct_index, accepted from questions where quiz_id = a.quiz_id loop
    if a.answers ? r.id::text then
      if r.kind = 'mcq' then
        ok := (a.answers ->> r.id::text)::int = r.correct_index;
else
        ok := _tita_match(a.answers ->> r.id::text, r.accepted);
end if;
      g := g || jsonb_build_object(r.id::text, ok);
      if ok then c := c + 1;
      elsif r.kind = 'mcq' then wm := wm + 1;
else wt := wt + 1;
end if;
else
      u := u + 1;
end if;
end loop;

  finished := case when p_reason = 'time' then a.deadline else least(now(), a.deadline) end;

update attempts set
                    status = 'submitted',
                    submitted_at = finished,
                    submit_reason = p_reason,
                    graded = g,
                    correct = c, wrong = wm + wt, unattempted = u,
                    score = c * q.marks_correct - wm * q.marks_wrong - wt * q.marks_wrong_tita,
                    time_taken_seconds = greatest(0, extract(epoch from (finished - a.started_at))::int)
where id = p_id;
end $$;

-- Closes an attempt when its own timer has run out.
create or replace function public._settle(p_id uuid, p_grace interval default interval '0') returns void
language plpgsql security definer set search_path = public as $$
declare a attempts%rowtype;
begin
select * into a from attempts where id = p_id;
if not found or a.status <> 'in_progress' then return; end if;
  -- only a student's own timer closes an attempt. Ending the quiz does not.
  if now() >= a.deadline + p_grace then
    perform _finalize_attempt(p_id, 'time');
end if;
end $$;

create or replace function public._questions_json(p_quiz uuid) returns jsonb
language sql stable security definer set search_path = public as $$
select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'body', body, 'options', options) order by position), '[]'::jsonb)
from questions where quiz_id = p_quiz;
$$;


-- The review opens when the admin has it on, the quiz has ended and no student is still working.
create or replace function public._review_open(p_quiz uuid) returns boolean
language sql stable security definer set search_path = public as $$
select q.show_review and q.status = 'ended'
           and not exists (select 1 from attempts a where a.quiz_id = q.id and a.status = 'in_progress' and now() < a.deadline)
from quizzes q where q.id = p_quiz;
$$;

create or replace function public._state_json(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a attempts%rowtype; q quizzes%rowtype; total numeric;
begin
select * into a from attempts where id = p_id;
select * into q from quizzes where id = a.quiz_id;
if a.status = 'in_progress' then
    return jsonb_build_object(
      'status', 'in_progress',
      'attempt_id', a.id,
      'started_at', a.started_at,
      'deadline', a.deadline,
      'server_now', now(),
      'title', q.title,
      'answers', a.answers,
      'questions', _questions_json(a.quiz_id));
end if;
select count(*) * q.marks_correct into total from questions where quiz_id = a.quiz_id;
return jsonb_build_object(
        'status', 'submitted',
        'server_now', now(),
        'title', q.title,
        'submitted_at', a.submitted_at,
        'reason', a.submit_reason,
        'show_score', q.show_score,
        'score', case when q.show_score then a.score end,
        'correct', case when q.show_score then a.correct end,
        'wrong', case when q.show_score then a.wrong end,
        'unattempted', case when q.show_score then a.unattempted end,
        'total_marks', case when q.show_score then total end,
        'time_taken_seconds', a.time_taken_seconds,
        'has_pin', (a.pin_hash is not null),
        'review_on', q.show_review,
        'review_available', coalesce(_review_open(a.quiz_id), false));
end $$;

create or replace function public._load_attempt(p_id uuid, p_token uuid, p_grace interval default interval '0') returns void
language plpgsql security definer set search_path = public as $$
begin
  perform 1 from attempts where id = p_id and token = p_token for update;
if not found then raise exception 'INVALID_ATTEMPT'; end if;
  perform _settle(p_id, p_grace);
end $$;

revoke all on function public._norm_num(text) from public, anon, authenticated;
revoke all on function public._tita_match(text, text[]) from public, anon, authenticated;
revoke all on function public._pin_hash(text, text) from public, anon, authenticated;
revoke all on function public._review_open(uuid) from public, anon, authenticated;
revoke all on function public._clean_answers(uuid, jsonb) from public, anon, authenticated;
revoke all on function public._finalize_attempt(uuid, text) from public, anon, authenticated;
revoke all on function public._settle(uuid, interval) from public, anon, authenticated;
revoke all on function public._questions_json(uuid) from public, anon, authenticated;
revoke all on function public._state_json(uuid) from public, anon, authenticated;
revoke all on function public._load_attempt(uuid, uuid, interval) from public, anon, authenticated;

-- ---------- student functions ----------

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
        'duration_minutes', q.duration_minutes,
        'marks_correct', q.marks_correct,
        'marks_wrong', q.marks_wrong,
        'marks_wrong_tita', q.marks_wrong_tita,
        'question_count', n,
        'tita_count', t);
end $$;

-- v4 added a PIN argument. Drop the old three argument version so the name stays unambiguous.
drop function if exists public.start_attempt(text, text, text);

create or replace function public.start_attempt(p_code text, p_name text, p_email text, p_pin text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
q quizzes%rowtype; v_name text; v_email text; v_id uuid; v_token uuid;
  v_pin text := nullif(btrim(coalesce(p_pin, '')), '');
  v_salt text; v_hash text;
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

  if v_pin is not null then
    v_salt := gen_random_uuid()::text;
    v_hash := _pin_hash(v_salt, v_pin);
end if;

insert into attempts (quiz_id, name, email, deadline, pin_salt, pin_hash)
values (q.id, v_name, v_email, now() + make_interval(mins => q.duration_minutes), v_salt, v_hash)
    on conflict do nothing
  returning id, token into v_id, v_token;

if v_id is null then raise exception 'ALREADY_ATTEMPTED'; end if;

return _state_json(v_id) || jsonb_build_object('token', v_token);
end $$;

create or replace function public.resume_attempt(p_attempt uuid, p_token uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform _load_attempt(p_attempt, p_token);
return _state_json(p_attempt);
end $$;

create or replace function public.save_answers(p_attempt uuid, p_token uuid, p_answers jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a attempts%rowtype;
begin
  perform _load_attempt(p_attempt, p_token);
select * into a from attempts where id = p_attempt;
if a.status = 'in_progress' then
update attempts set answers = _clean_answers(a.quiz_id, p_answers) where id = p_attempt;
return jsonb_build_object('status', 'in_progress', 'server_now', now(), 'deadline', a.deadline);
end if;
return _state_json(p_attempt);
end $$;

create or replace function public.submit_attempt(p_attempt uuid, p_token uuid, p_answers jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a attempts%rowtype;
begin
  -- a 15 second grace covers slow networks when the timer hits zero
  perform _load_attempt(p_attempt, p_token, interval '15 seconds');
select * into a from attempts where id = p_attempt;
if a.status = 'in_progress' then
update attempts set answers = _clean_answers(a.quiz_id, p_answers) where id = p_attempt;
perform _finalize_attempt(p_attempt, case when now() >= a.deadline then 'time' else 'manual' end);
end if;
return _state_json(p_attempt);
end $$;

grant execute on function public.quiz_info(text) to anon, authenticated;
grant execute on function public.start_attempt(text, text, text, text) to anon, authenticated;
grant execute on function public.resume_attempt(uuid, uuid) to anon, authenticated;
grant execute on function public.save_answers(uuid, uuid, jsonb) to anon, authenticated;
grant execute on function public.submit_attempt(uuid, uuid, jsonb) to anon, authenticated;

-- Answer review for a student. Only when the admin turned review on, the quiz has ended and nobody is still working.
create or replace function public.get_review(p_attempt uuid, p_token uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a attempts%rowtype; q quizzes%rowtype;
begin
  perform _load_attempt(p_attempt, p_token);
select * into a from attempts where id = p_attempt;
select * into q from quizzes where id = a.quiz_id;
if a.status <> 'submitted' or not coalesce(_review_open(q.id), false) then
    raise exception 'REVIEW_NOT_AVAILABLE';
end if;
return jsonb_build_object(
        'title', q.title,
        'items', (
            select coalesce(jsonb_agg(jsonb_build_object(
                    'id', z.id,
                    'kind', z.kind,
                    'body', z.body,
                    'options', z.options,
                    'your', a.answers -> z.id::text,
                    'correct', case when z.kind = 'mcq' then to_jsonb(z.correct_index) else to_jsonb(z.accepted) end,
                    'ok', a.graded -> z.id::text,
                    'explanation', z.explanation) order by z.position), '[]'::jsonb)
            from questions z where z.quiz_id = q.id));
end $$;

grant execute on function public.get_review(uuid, uuid) to anon, authenticated;

-- Find a result again with the email and PIN the student used. Five wrong tries lock that attempt for 15 minutes.
-- A wrong answer is returned, not raised, so the failure count is saved.
create or replace function public.find_my_result(p_code text, p_email text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare att attempts%rowtype; v_pin text := btrim(coalesce(p_pin, ''));
begin
select t.* into att
from attempts t join quizzes z on z.id = t.quiz_id
where z.code = upper(trim(p_code)) and lower(t.email) = lower(trim(coalesce(p_email, '')))
    for update of t;

if not found or att.pin_hash is null then
    return jsonb_build_object('ok', false, 'locked', false);
end if;
  if att.pin_locked_until is not null and att.pin_locked_until > now() then
    return jsonb_build_object('ok', false, 'locked', true);
end if;

  if _pin_hash(att.pin_salt, v_pin) = att.pin_hash then
update attempts set pin_fails = 0, pin_locked_until = null where id = att.id;
return jsonb_build_object('ok', true, 'attempt_id', att.id, 'token', att.token);
end if;

  if att.pin_fails + 1 >= 5 then
update attempts set pin_fails = 0, pin_locked_until = now() + interval '15 minutes' where id = att.id;
return jsonb_build_object('ok', false, 'locked', true);
end if;
update attempts set pin_fails = att.pin_fails + 1 where id = att.id;
return jsonb_build_object('ok', false, 'locked', false);
end $$;

grant execute on function public.find_my_result(text, text, text) to anon, authenticated;

-- Set or change the PIN of an attempt. Needs the attempt secret, so it works from the student's own result page.
-- This is how students who attempted before PINs existed can add one.
create or replace function public.set_my_pin(p_attempt uuid, p_token uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_pin text := btrim(coalesce(p_pin, '')); v_salt text;
begin
  perform _load_attempt(p_attempt, p_token);
  if v_pin !~ '^[0-9]{4,6}$' then raise exception 'BAD_PIN'; end if;
  v_salt := gen_random_uuid()::text;
update attempts
set pin_salt = v_salt, pin_hash = _pin_hash(v_salt, v_pin), pin_fails = 0, pin_locked_until = null
where id = p_attempt;
return _state_json(p_attempt);
end $$;

grant execute on function public.set_my_pin(uuid, uuid, text) to anon, authenticated;

-- ---------- admin functions ----------

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
else
    raise exception 'BAD_TRANSITION';
end if;
end $$;


-- Submits everyone who is still working, for when you do not want to wait for their timers.
create or replace function public.submit_all_in_progress(p_quiz uuid) returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
for r in select id, deadline from attempts where quiz_id = p_quiz and status = 'in_progress' loop
    perform _finalize_attempt(r.id, case when now() >= r.deadline then 'time' else 'ended' end);
n := n + 1;
end loop;
return n;
end $$;

revoke all on function public.submit_all_in_progress(uuid) from public, anon;
grant execute on function public.submit_all_in_progress(uuid) to authenticated;

-- Closes attempts whose timer ran out. The results page calls this on refresh.
create or replace function public.finalize_expired(p_quiz uuid) returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
for r in select id from attempts where quiz_id = p_quiz and status = 'in_progress' and now() >= deadline loop
    perform _finalize_attempt(r.id, 'time');
n := n + 1;
end loop;
return n;
end $$;

revoke all on function public.set_quiz_status(uuid, text) from public, anon;
revoke all on function public.finalize_expired(uuid) from public, anon;
grant execute on function public.set_quiz_status(uuid, text) to authenticated;
grant execute on function public.finalize_expired(uuid) to authenticated;


-- Closes every attempt whose timer ran out. Meant for the scheduled job in cron.sql.
create or replace function public.close_expired_attempts() returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
for r in select id from attempts where status = 'in_progress' and now() >= deadline loop
    perform _settle(r.id);
n := n + 1;
end loop;
return n;
end $$;

revoke all on function public.close_expired_attempts() from public, anon, authenticated;

-- ---------- after running this file ----------
-- 1. Supabase dashboard > Authentication > Users > Add user (your email + password).
-- 2. Then run this with your email to make that user an admin.
--    insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';
-- 3. Authentication > Providers > Email > turn OFF "Allow new users to sign up".
-- 4. Run cron.sql once so timed-out attempts close on their own.