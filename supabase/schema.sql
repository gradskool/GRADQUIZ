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


-- The review opens as soon as a student submits, when the admin has it on.
-- get_review and _state_json only offer it for a submitted attempt.
create or replace function public._review_open(p_quiz uuid) returns boolean
language sql stable security definer set search_path = public as $$
select q.show_review from quizzes q where q.id = p_quiz;
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

-- ================= v5: Invited only quizzes (same as patch_invited_only.sql) =================


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

-- ================= v6: round 3 (same as patch_round3.sql) =================

-- ---------- columns ----------

alter table public.quizzes   add column if not exists show_leaderboard boolean not null default false;
alter table public.quizzes   add column if not exists shuffle_questions boolean not null default false;
alter table public.quizzes   add column if not exists shuffle_options boolean not null default false;
alter table public.quizzes   add column if not exists starts_at timestamptz;
alter table public.quizzes   add column if not exists ends_at timestamptz;
alter table public.questions add column if not exists bonus boolean not null default false;
alter table public.attempts  add column if not exists times jsonb not null default '{}'::jsonb;
alter table public.attempts  add column if not exists tab_switches int not null default 0;
alter table public.attempts  add column if not exists away_seconds int not null default 0;
alter table public.attempts  add column if not exists q_order uuid[];
alter table public.attempts  add column if not exists opt_order jsonb;
-- used by the results page for students who asked for their link (already in the live database, harmless to repeat)
alter table public.attempts  add column if not exists link_requested_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.quizzes'::regclass and conname = 'quizzes_schedule_check') then
    alter table public.quizzes add constraint quizzes_schedule_check check (starts_at is null or ends_at is null or ends_at > starts_at);
  end if;
end $$;

create index if not exists attempts_email on public.attempts (lower(email));

-- ---------- 1. answer key can change after start ----------

-- After start only the explanation, the answer key and the bonus flag can change.
create or replace function public._lock_questions() returns trigger
language plpgsql security definer set search_path = public as $$
declare s text;
begin
  select status into s from quizzes where id = coalesce(new.quiz_id, old.quiz_id);
  if s is not null and s <> 'draft' then
    if tg_op = 'UPDATE' and
       (new.quiz_id, new.position, new.kind, new.body, new.options)
       is not distinct from
       (old.quiz_id, old.position, old.kind, old.body, old.options) then
      return new;
    end if;
    raise exception 'QUIZ_LOCKED';
  end if;
  return coalesce(new, old);
end $$;

-- Scores one attempt from its saved answers and the current key. A bonus question counts as correct for everyone.
create or replace function public._grade(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  a attempts%rowtype; q quizzes%rowtype; r record; ok boolean;
  c int := 0; wm int := 0; wt int := 0; u int := 0;
  g jsonb := '{}'::jsonb;
begin
  select * into a from attempts where id = p_id;
  if not found then return; end if;
  select * into q from quizzes where id = a.quiz_id;
  for r in select id, kind, correct_index, accepted, bonus from questions where quiz_id = a.quiz_id loop
    if r.bonus then
      g := g || jsonb_build_object(r.id::text, true);
      c := c + 1;
    elsif a.answers ? r.id::text then
      if r.kind = 'mcq' then ok := (a.answers ->> r.id::text)::int = r.correct_index;
      else ok := _tita_match(a.answers ->> r.id::text, r.accepted);
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
  update attempts set
    graded = g, correct = c, wrong = wm + wt, unattempted = u,
    score = c * q.marks_correct - wm * q.marks_wrong - wt * q.marks_wrong_tita
  where id = p_id;
end $$;

create or replace function public._finalize_attempt(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare a attempts%rowtype; finished timestamptz;
begin
  select * into a from attempts where id = p_id for update;
  if not found or a.status = 'submitted' then return; end if;
  finished := case when p_reason = 'time' then a.deadline else least(now(), a.deadline) end;
  update attempts set
    status = 'submitted',
    submitted_at = finished,
    submit_reason = p_reason,
    time_taken_seconds = greatest(0, extract(epoch from (finished - a.started_at))::int)
  where id = p_id;
  perform _grade(p_id);
end $$;

create or replace function public._regrade_on_key_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if exists (select 1 from quizzes where id = new.quiz_id and status <> 'draft') then
    for r in select id from attempts where quiz_id = new.quiz_id and status = 'submitted' loop
      perform _grade(r.id);
    end loop;
  end if;
  return null;
end $$;

drop trigger if exists questions_regrade on public.questions;
create trigger questions_regrade after update of correct_index, accepted, bonus on public.questions
  for each row
  when (old.correct_index is distinct from new.correct_index
     or old.accepted is distinct from new.accepted
     or old.bonus is distinct from new.bonus)
  execute function public._regrade_on_key_change();

-- ---------- 5. shuffle, fixed per attempt when it starts ----------

create or replace function public._attempt_shuffle() returns trigger
language plpgsql security definer set search_path = public as $$
declare q quizzes%rowtype;
begin
  select * into q from quizzes where id = new.quiz_id;
  if q.shuffle_questions then
    new.q_order := (select array_agg(id order by random()) from questions where quiz_id = new.quiz_id);
  end if;
  if q.shuffle_options then
    new.opt_order := (
      select jsonb_object_agg(z.id::text,
        (select jsonb_agg(i order by random()) from generate_series(0, jsonb_array_length(z.options) - 1) i))
      from questions z where z.quiz_id = new.quiz_id and z.kind = 'mcq');
  end if;
  return new;
end $$;

drop trigger if exists attempts_shuffle on public.attempts;
create trigger attempts_shuffle before insert on public.attempts
  for each row execute function public._attempt_shuffle();

-- Questions in this attempt's order. Options stay in their original order, opt_map says how to show them.
-- Answers are always the original option index.
create or replace function public._attempt_questions_json(p_attempt uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', z.id, 'kind', z.kind, 'body', z.body, 'options', z.options,
      'opt_map', a.opt_order -> z.id::text)
    order by coalesce(array_position(a.q_order, z.id), 0), z.position), '[]'::jsonb)
  from attempts a join questions z on z.quiz_id = a.quiz_id
  where a.id = p_attempt;
$$;

-- ---------- 2. rank and percentile ----------

-- Rank counts students with a higher score. Percentile is the share of submitted students at or below your score.
create or replace function public._rank_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
      'rank', 1 + count(*) filter (where s.score > me.score),
      'of', count(*),
      'percentile', round(100.0 * count(*) filter (where s.score <= me.score) / nullif(count(*), 0), 2))
  from attempts me
  join attempts s on s.quiz_id = me.quiz_id and s.status = 'submitted' and s.score is not null
  where me.id = p_id and me.status = 'submitted' and me.score is not null
  group by me.score;
$$;

create or replace function public._leaderboard_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('rank', rk, 'name', name, 'score', score, 'me', id = p_id) order by rk, t), '[]'::jsonb)
  from (
    select b.id, b.name, b.score, coalesce(b.time_taken_seconds, 0) t, rank() over (order by b.score desc) rk
    from attempts b
    where b.quiz_id = (select quiz_id from attempts where id = p_id) and b.status = 'submitted' and b.score is not null
    order by rk, t
    limit 10
  ) top;
$$;

-- ---------- 3. time per question and tab tracking ----------

-- Saves what the page measured. Numbers are clamped so a tampered page cannot store nonsense.
create or replace function public._apply_meta(p_id uuid, p_meta jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare a attempts%rowtype; lim numeric; t jsonb;
begin
  if p_meta is null or jsonb_typeof(p_meta) <> 'object' then return; end if;
  select * into a from attempts where id = p_id;
  if not found or a.status <> 'in_progress' then return; end if;
  lim := greatest(0, extract(epoch from (a.deadline - a.started_at))) + 60;

  if jsonb_typeof(p_meta -> 'times') = 'object' then
    select coalesce(jsonb_object_agg(z.id::text,
             least(lim, greatest(0, (p_meta -> 'times' ->> z.id::text)::numeric))::int), '{}'::jsonb)
      into t
    from questions z
    where z.quiz_id = a.quiz_id and jsonb_typeof(p_meta -> 'times' -> z.id::text) = 'number';
    update attempts set times = t where id = p_id;
  end if;
  if jsonb_typeof(p_meta -> 'tabs') = 'number' then
    update attempts set tab_switches = greatest(tab_switches, least(100000, greatest(0, (p_meta ->> 'tabs')::numeric))::int) where id = p_id;
  end if;
  if jsonb_typeof(p_meta -> 'away') = 'number' then
    update attempts set away_seconds = greatest(away_seconds, least(lim, greatest(0, (p_meta ->> 'away')::numeric))::int) where id = p_id;
  end if;
end $$;

-- ---------- student state ----------

create or replace function public._state_json(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a attempts%rowtype; q quizzes%rowtype; total numeric; rk jsonb;
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
      'times', a.times,
      'tabs', a.tab_switches,
      'away', a.away_seconds,
      'questions', _attempt_questions_json(a.id));
  end if;
  select count(*) * q.marks_correct into total from questions where quiz_id = a.quiz_id;
  if q.show_score then rk := _rank_json(p_id); end if;
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
    'rank', rk -> 'rank',
    'of', rk -> 'of',
    'percentile', rk -> 'percentile',
    'leaderboard', case when q.show_score and q.show_leaderboard then _leaderboard_json(p_id) end,
    'time_taken_seconds', a.time_taken_seconds,
    'has_pin', (a.pin_hash is not null),
    'review_on', q.show_review,
    'review_available', coalesce(_review_open(a.quiz_id), false));
end $$;

-- save and submit take an optional p_meta: {"times": {question id: seconds}, "tabs": n, "away": seconds}
drop function if exists public.save_answers(uuid, uuid, jsonb);
drop function if exists public.submit_attempt(uuid, uuid, jsonb);

create or replace function public.save_answers(p_attempt uuid, p_token uuid, p_answers jsonb, p_meta jsonb default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a attempts%rowtype;
begin
  perform _load_attempt(p_attempt, p_token);
  select * into a from attempts where id = p_attempt;
  if a.status = 'in_progress' then
    update attempts set answers = _clean_answers(a.quiz_id, p_answers) where id = p_attempt;
    perform _apply_meta(p_attempt, p_meta);
    return jsonb_build_object('status', 'in_progress', 'server_now', now(), 'deadline', a.deadline);
  end if;
  return _state_json(p_attempt);
end $$;

create or replace function public.submit_attempt(p_attempt uuid, p_token uuid, p_answers jsonb, p_meta jsonb default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a attempts%rowtype;
begin
  -- a 15 second grace covers slow networks when the timer hits zero
  perform _load_attempt(p_attempt, p_token, interval '15 seconds');
  select * into a from attempts where id = p_attempt;
  if a.status = 'in_progress' then
    update attempts set answers = _clean_answers(a.quiz_id, p_answers) where id = p_attempt;
    perform _apply_meta(p_attempt, p_meta);
    perform _finalize_attempt(p_attempt, case when now() >= a.deadline then 'time' else 'manual' end);
  end if;
  return _state_json(p_attempt);
end $$;

grant execute on function public.save_answers(uuid, uuid, jsonb, jsonb) to anon, authenticated;
grant execute on function public.submit_attempt(uuid, uuid, jsonb, jsonb) to anon, authenticated;

-- Review: bonus flag, your time, the class average time and your option order.
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
          'opt_map', a.opt_order -> z.id::text,
          'your', a.answers -> z.id::text,
          'correct', case when z.kind = 'mcq' then to_jsonb(z.correct_index) else to_jsonb(z.accepted) end,
          'ok', a.graded -> z.id::text,
          'bonus', z.bonus,
          'time', a.times -> z.id::text,
          'avg_time', (select round(avg((t.times ->> z.id::text)::numeric)) from attempts t
                        where t.quiz_id = z.quiz_id and t.status = 'submitted' and t.times ? z.id::text),
          'explanation', z.explanation)
        order by coalesce(array_position(a.q_order, z.id), 0), z.position), '[]'::jsonb)
      from questions z where z.quiz_id = q.id));
end $$;

grant execute on function public.get_review(uuid, uuid) to anon, authenticated;

-- ---------- 4. schedules ----------

-- Starts or closes one quiz when its scheduled time has passed. Called on every student visit and by the minute job.
create or replace function public._apply_schedule(p_quiz uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update quizzes set status = 'live', started_at = now()
  where id = p_quiz and status = 'draft' and starts_at is not null and starts_at <= now()
    and exists (select 1 from questions where quiz_id = p_quiz);
  update quizzes set status = 'ended', ended_at = now()
  where id = p_quiz and status = 'live' and ends_at is not null and ends_at <= now();
end $$;

create or replace function public._apply_schedules() returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select id from quizzes
           where (status = 'draft' and starts_at <= now()) or (status = 'live' and ends_at <= now()) loop
    perform _apply_schedule(r.id);
  end loop;
end $$;

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
    'duration_minutes', q.duration_minutes,
    'marks_correct', q.marks_correct,
    'marks_wrong', q.marks_wrong,
    'marks_wrong_tita', q.marks_wrong_tita,
    'question_count', n,
    'tita_count', t);
end $$;

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

-- The results page calls this on every refresh, so scheduled changes show there right away.
create or replace function public.finalize_expired(p_quiz uuid) returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  perform _apply_schedule(p_quiz);
  for r in select id from attempts where quiz_id = p_quiz and status = 'in_progress' and now() >= deadline loop
    perform _finalize_attempt(r.id, 'time');
    n := n + 1;
  end loop;
  return n;
end $$;

-- The minute job (cron.sql) also runs schedules now. No new job is needed.
create or replace function public.close_expired_attempts() returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  perform _apply_schedules();
  for r in select id from attempts where status = 'in_progress' and now() >= deadline loop
    perform _settle(r.id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- 6. student history (admin only) ----------

create or replace function public.admin_students() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  return (
    with ranked as (
      select lower(a.email) email, a.name, a.started_at, a.status,
             case when a.status = 'submitted' and a.score is not null
                  then 100 * cume_dist() over (partition by a.quiz_id, (a.status = 'submitted' and a.score is not null) order by a.score) end pct
      from attempts a
    ),
    agg as (
      select email,
             (array_agg(name order by started_at desc))[1] as name,
             count(*) as quizzes,
             count(*) filter (where status = 'submitted') as submitted,
             round(avg(pct)::numeric, 1) as avg_pct,
             round(max(pct)::numeric, 1) as best_pct,
             max(started_at) as last_at
      from ranked group by email
    )
    select coalesce(jsonb_agg(to_jsonb(agg) order by last_at desc), '[]'::jsonb) from agg);
end $$;

create or replace function public.admin_student_history(p_email text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  return (
    with scored as (
      select a.*,
             rank() over w as rk,
             count(*) over (partition by a.quiz_id) as n,
             100 * cume_dist() over (partition by a.quiz_id order by a.score) as pct
      from attempts a
      where a.status = 'submitted' and a.score is not null
        and a.quiz_id in (select quiz_id from attempts where lower(email) = lower(btrim(p_email)))
      window w as (partition by a.quiz_id order by a.score desc)
    )
    select coalesce(jsonb_agg(jsonb_build_object(
        'attempt_id', a.id,
        'quiz_id', z.id, 'title', z.title, 'code', z.code,
        'name', a.name, 'email', a.email, 'status', a.status,
        'started_at', a.started_at, 'submitted_at', a.submitted_at,
        'score', a.score, 'correct', a.correct, 'wrong', a.wrong, 'unattempted', a.unattempted,
        'total_marks', (select count(*) from questions x where x.quiz_id = z.id) * z.marks_correct,
        'time_taken_seconds', a.time_taken_seconds,
        'tab_switches', a.tab_switches, 'away_seconds', a.away_seconds,
        'rank', s.rk, 'of', s.n, 'percentile', round(s.pct::numeric, 1))
      order by a.started_at desc), '[]'::jsonb)
    from attempts a
    join quizzes z on z.id = a.quiz_id
    left join scored s on s.id = a.id
    where lower(a.email) = lower(btrim(p_email)));
end $$;

-- ---------- permissions ----------

revoke all on function public._grade(uuid) from public, anon, authenticated;
revoke all on function public._attempt_questions_json(uuid) from public, anon, authenticated;
revoke all on function public._rank_json(uuid) from public, anon, authenticated;
revoke all on function public._leaderboard_json(uuid) from public, anon, authenticated;
revoke all on function public._apply_meta(uuid, jsonb) from public, anon, authenticated;
revoke all on function public._apply_schedule(uuid) from public, anon, authenticated;
revoke all on function public._apply_schedules() from public, anon, authenticated;
revoke all on function public._finalize_attempt(uuid, text) from public, anon, authenticated;
revoke all on function public._state_json(uuid) from public, anon, authenticated;
revoke all on function public.finalize_expired(uuid) from public, anon;
grant execute on function public.finalize_expired(uuid) to authenticated;
revoke all on function public.close_expired_attempts() from public, anon, authenticated;
revoke all on function public.admin_students() from public, anon;
revoke all on function public.admin_student_history(text) from public, anon;
grant execute on function public.admin_students() to authenticated;
grant execute on function public.admin_student_history(text) to authenticated;

notify pgrst, 'reload schema';

-- ================= v7: round 4 (same as patch_round4.sql) =================

alter table public.quizzes add column if not exists allow_practice boolean not null default false;

-- ---------- 1. top 3 ----------

create or replace function public._leaderboard_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('rank', rk, 'name', name, 'score', score, 'me', id = p_id) order by rk, t), '[]'::jsonb)
  from (
    select b.id, b.name, b.score, coalesce(b.time_taken_seconds, 0) t, rank() over (order by b.score desc) rk
    from attempts b
    where b.quiz_id = (select quiz_id from attempts where id = p_id) and b.status = 'submitted' and b.score is not null
    order by rk, t
    limit 3
  ) top;
$$;

-- ---------- student state now says whether practice is open ----------

create or replace function public._state_json(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a attempts%rowtype; q quizzes%rowtype; total numeric; rk jsonb;
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
      'times', a.times,
      'tabs', a.tab_switches,
      'away', a.away_seconds,
      'questions', _attempt_questions_json(a.id));
  end if;
  select count(*) * q.marks_correct into total from questions where quiz_id = a.quiz_id;
  if q.show_score then rk := _rank_json(p_id); end if;
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
    'rank', rk -> 'rank',
    'of', rk -> 'of',
    'percentile', rk -> 'percentile',
    'leaderboard', case when q.show_score and q.show_leaderboard then _leaderboard_json(p_id) end,
    'time_taken_seconds', a.time_taken_seconds,
    'has_pin', (a.pin_hash is not null),
    'review_on', q.show_review,
    'review_available', coalesce(_review_open(a.quiz_id), false),
    'practice_available', q.allow_practice);
end $$;

-- quiz_info tells the lobby when anyone with the code may practise (open quiz, ended, practice on)
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
    'duration_minutes', q.duration_minutes,
    'marks_correct', q.marks_correct,
    'marks_wrong', q.marks_wrong,
    'marks_wrong_tita', q.marks_wrong_tita,
    'question_count', n,
    'tita_count', t);
end $$;

-- ---------- 2. practice ----------

-- Only a student with their own submitted attempt may practise.
create or replace function public._practice_quiz(p_code text, p_attempt uuid, p_token uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare q quizzes%rowtype;
begin
  select * into q from quizzes where code = upper(btrim(coalesce(p_code, '')));
  if not found then raise exception 'QUIZ_NOT_FOUND'; end if;
  if not q.allow_practice then raise exception 'PRACTICE_OFF'; end if;
  if p_attempt is not null and exists (
       select 1 from attempts where id = p_attempt and token = p_token and quiz_id = q.id and status = 'submitted') then
    return q.id;
  end if;
  raise exception 'PRACTICE_NOT_OPEN';
end $$;

create or replace function public.practice_questions(p_code text, p_attempt uuid default null, p_token uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_quiz uuid; q quizzes%rowtype;
begin
  v_quiz := _practice_quiz(p_code, p_attempt, p_token);
  select * into q from quizzes where id = v_quiz;
  return jsonb_build_object(
    'title', q.title,
    'marks_correct', q.marks_correct, 'marks_wrong', q.marks_wrong, 'marks_wrong_tita', q.marks_wrong_tita,
    'questions', _questions_json(v_quiz));
end $$;

-- Scores a practice run without saving anything. Returns the same shape as get_review plus the score.
create or replace function public.practice_check(p_code text, p_answers jsonb, p_attempt uuid default null, p_token uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_quiz uuid; q quizzes%rowtype; r record; given jsonb; ok boolean;
  c int := 0; wm int := 0; wt int := 0; u int := 0;
  items jsonb := '[]'::jsonb;
begin
  v_quiz := _practice_quiz(p_code, p_attempt, p_token);
  select * into q from quizzes where id = v_quiz;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then p_answers := '{}'::jsonb; end if;

  for r in select * from questions where quiz_id = v_quiz order by position loop
    given := p_answers -> r.id::text;
    -- keep only a valid answer
    if r.kind = 'mcq' then
      if not (jsonb_typeof(given) = 'number' and (given #>> '{}') ~ '^[0-9]{1,2}$'
              and (given #>> '{}')::int < jsonb_array_length(r.options)) then given := null; end if;
    else
      if jsonb_typeof(given) = 'string' and btrim(given #>> '{}') <> '' then given := to_jsonb(left(btrim(given #>> '{}'), 40));
      else given := null; end if;
    end if;

    if r.bonus then ok := true;
    elsif given is null then ok := null;
    elsif r.kind = 'mcq' then ok := (given #>> '{}')::int = r.correct_index;
    else ok := _tita_match(given #>> '{}', r.accepted);
    end if;

    if ok is null then u := u + 1;
    elsif ok then c := c + 1;
    elsif r.kind = 'mcq' then wm := wm + 1;
    else wt := wt + 1;
    end if;

    items := items || jsonb_build_array(jsonb_build_object(
      'id', r.id, 'kind', r.kind, 'body', r.body, 'options', r.options,
      'your', given,
      'correct', case when r.kind = 'mcq' then to_jsonb(r.correct_index) else to_jsonb(r.accepted) end,
      'ok', ok, 'bonus', r.bonus, 'explanation', r.explanation,
      'avg_time', (select round(avg((t.times ->> r.id::text)::numeric)) from attempts t
                    where t.quiz_id = v_quiz and t.status = 'submitted' and t.times ? r.id::text)));
  end loop;

  return jsonb_build_object(
    'title', q.title,
    'score', c * q.marks_correct - wm * q.marks_wrong - wt * q.marks_wrong_tita,
    'total_marks', (select count(*) from questions where quiz_id = v_quiz) * q.marks_correct,
    'correct', c, 'wrong', wm + wt, 'unattempted', u,
    'items', items);
end $$;

grant execute on function public.practice_questions(text, uuid, uuid) to anon, authenticated;
grant execute on function public.practice_check(text, jsonb, uuid, uuid) to anon, authenticated;

-- ---------- 3. report ----------

create or replace function public._report_json(p_id uuid, p_key boolean) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a attempts%rowtype; q quizzes%rowtype; rk jsonb; total numeric;
begin
  select * into a from attempts where id = p_id;
  select * into q from quizzes where id = a.quiz_id;
  rk := _rank_json(p_id);
  select count(*) * q.marks_correct into total from questions where quiz_id = q.id;
  return jsonb_build_object(
    'title', q.title, 'code', q.code,
    'name', a.name, 'email', a.email,
    'started_at', a.started_at, 'submitted_at', a.submitted_at, 'reason', a.submit_reason,
    'duration_minutes', q.duration_minutes, 'time_taken_seconds', a.time_taken_seconds,
    'score', a.score, 'total_marks', total,
    'correct', a.correct, 'wrong', a.wrong, 'unattempted', a.unattempted,
    'rank', rk -> 'rank', 'of', rk -> 'of', 'percentile', rk -> 'percentile',
    'tabs', a.tab_switches, 'away', a.away_seconds,
    'class_avg', (select round(avg(score), 2) from attempts where quiz_id = q.id and status = 'submitted'),
    'class_top', (select max(score) from attempts where quiz_id = q.id and status = 'submitted'),
    'with_key', p_key,
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
          'kind', z.kind,
          'ok', a.graded -> z.id::text,
          'bonus', z.bonus,
          'your', case when p_key then a.answers -> z.id::text end,
          'answered', a.answers ? z.id::text,
          'correct', case when not p_key then null when z.kind = 'mcq' then to_jsonb(z.correct_index) else to_jsonb(z.accepted) end,
          'opt_map', a.opt_order -> z.id::text,
          'time', a.times -> z.id::text,
          'avg_time', (select round(avg((t.times ->> z.id::text)::numeric)) from attempts t
                        where t.quiz_id = z.quiz_id and t.status = 'submitted' and t.times ? z.id::text))
        order by coalesce(array_position(a.q_order, z.id), 0), z.position), '[]'::jsonb)
      from questions z where z.quiz_id = q.id));
end $$;

-- A student's own report. Needs the score to be shown. Answers and the key are included only when review is open.
create or replace function public.get_report(p_attempt uuid, p_token uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a attempts%rowtype; q quizzes%rowtype;
begin
  perform _load_attempt(p_attempt, p_token);
  select * into a from attempts where id = p_attempt;
  select * into q from quizzes where id = a.quiz_id;
  if a.status <> 'submitted' or not q.show_score then raise exception 'REPORT_NOT_AVAILABLE'; end if;
  return _report_json(p_attempt, coalesce(_review_open(q.id), false));
end $$;

create or replace function public.admin_report(p_attempt uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  if not exists (select 1 from attempts where id = p_attempt and status = 'submitted') then raise exception 'REPORT_NOT_AVAILABLE'; end if;
  return _report_json(p_attempt, true);
end $$;

-- ---------- permissions ----------

revoke all on function public._practice_quiz(text, uuid, uuid) from public, anon, authenticated;
revoke all on function public._report_json(uuid, boolean) from public, anon, authenticated;
revoke all on function public._leaderboard_json(uuid) from public, anon, authenticated;
revoke all on function public._state_json(uuid) from public, anon, authenticated;
grant execute on function public.get_report(uuid, uuid) to anon, authenticated;
revoke all on function public.admin_report(uuid) from public, anon;
grant execute on function public.admin_report(uuid) to authenticated;

notify pgrst, 'reload schema';

-- ================= v8: student progress (same as patch_progress.sql) =================

create or replace function public.my_progress(p_items jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 300 then
    return '[]'::jsonb;
  end if;
  return (
    with pairs as (
      select case when (e ->> 'a') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (e ->> 'a')::uuid end as a,
             case when (e ->> 't') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (e ->> 't')::uuid end as t
      from jsonb_array_elements(p_items) e
      where jsonb_typeof(e) = 'object'
    ),
    mine as (
      select distinct a.* from attempts a join pairs p on a.id = p.a and a.token = p.t
      where a.status = 'submitted' and a.score is not null
    ),
    scored as (
      select b.id,
             rank() over (partition by b.quiz_id order by b.score desc) as rk,
             count(*) over (partition by b.quiz_id) as n,
             100 * cume_dist() over (partition by b.quiz_id order by b.score) as pct,
             avg(b.score) over (partition by b.quiz_id) as cavg
      from attempts b
      where b.status = 'submitted' and b.score is not null and b.quiz_id in (select quiz_id from mine)
    )
    select coalesce(jsonb_agg(jsonb_build_object(
        'attempt_id', m.id, 'email', lower(m.email), 'name', m.name,
        'title', z.title, 'code', z.code,
        'submitted_at', m.submitted_at, 'time_taken_seconds', m.time_taken_seconds, 'duration_minutes', z.duration_minutes,
        'score', m.score,
        'total_marks', (select count(*) from questions x where x.quiz_id = z.id) * z.marks_correct,
        'correct', m.correct, 'wrong', m.wrong, 'unattempted', m.unattempted,
        'rank', s.rk, 'of', s.n, 'percentile', round(s.pct::numeric, 2), 'class_avg', round(s.cavg, 2))
      order by m.submitted_at desc), '[]'::jsonb)
    from mine m
    join quizzes z on z.id = m.quiz_id and z.show_score
    join scored s on s.id = m.id);
end $$;

grant execute on function public.my_progress(jsonb) to anon, authenticated;

notify pgrst, 'reload schema';

-- ================= v9: round 5 (same as patch_round5.sql) =================

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
  v_pin := lpad(((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint) % 10000)::text, 4, '0');
  update attempts
  set pin_salt = v_salt, pin_hash = _pin_hash(v_salt, v_pin), pin_fails = 0, pin_locked_until = null, link_requested_at = null
  where id = p_attempt;
  return v_pin;
end $$;

revoke all on function public.admin_reset_pin(uuid) from public, anon;
grant execute on function public.admin_reset_pin(uuid) to authenticated;

notify pgrst, 'reload schema';

-- ================= v10: student library (same as patch_library.sql) =================

alter table public.quizzes add column if not exists batch text;
alter table public.quizzes add column if not exists topic text;
alter table public.quizzes add column if not exists in_library boolean not null default true;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.quizzes'::regclass and conname = 'quizzes_batch_len') then
    alter table public.quizzes add constraint quizzes_batch_len check (batch is null or length(batch) between 1 and 60);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.quizzes'::regclass and conname = 'quizzes_topic_len') then
    alter table public.quizzes add constraint quizzes_topic_len check (topic is null or length(topic) between 1 and 60);
  end if;
end $$;

create index if not exists quizzes_batch on public.quizzes (lower(batch));

-- p_items: the attempt ids and secrets this device holds, like my_progress.
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
          'code', z.code, 'title', z.title,
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
        and (z.status in ('live', 'ended') or (z.status = 'draft' and z.starts_at is not null))
        and (z.access = 'open'
             or exists (select 1 from quiz_invites i where i.quiz_id = z.id and i.email = any (v_emails))
             or exists (select 1 from attempts m where m.quiz_id = z.id and lower(m.email) = any (v_emails)))
    ), '[]'::jsonb));
end $$;

grant execute on function public.my_library(jsonb) to anon, authenticated;

notify pgrst, 'reload schema';

-- ================= v11: programs (same as patch_programs.sql) =================

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

-- ================= v12: LRDI weeks and week order (same as patch_weeks.sql) =================
-- GRADQUIZ patch: LRDI weeks. Run once in the Supabase SQL Editor, after patch_programs.sql. Safe to run again.
-- A week (Week 3, named by its Topic) has days. Each Core, Challenge and Surprise day has a Pre-quiz that students
-- take before the session. Core and Challenge days also have a Quiz that unlocks after the session (you start it).
-- One Sectional per week comes after the Surprise day. Extra sectionals sit outside weeks in their own group.
-- Quizzes of a week that are not open yet show to students as locked. A scheduled Surprise day pre-quiz shows
-- no title, time or size until it goes live.
-- In a week, each pre-quiz, quiz and the sectional opens for a student only after they submit the one before it
-- (order: Core days, Challenge days, Surprise days, Sectional; in a day the Pre-quiz comes before the Quiz).

alter table public.quizzes add column if not exists week_no int;
alter table public.quizzes add column if not exists day_type text;
alter table public.quizzes add column if not exists day_no int;
alter table public.quizzes add column if not exists part text;
alter table public.quizzes drop constraint if exists quizzes_week_check;
alter table public.quizzes add constraint quizzes_week_check check (
  (week_no is null or week_no between 1 and 500)
  and (day_type is null or day_type in ('core', 'challenge', 'surprise', 'sectional', 'extra'))
  and (day_no is null or day_no between 1 and 50)
  and (part is null or part in ('pre', 'post')));

-- ---------- week order ----------

-- Place in the week: Core days, then Challenge days, then Surprise days, then the Sectional. Pre-quiz before Quiz.
create or replace function public._week_rank(p_day text, p_no int, p_part text) returns int
language sql immutable as $$
  select case p_day when 'core' then 0 when 'challenge' then 1 when 'surprise' then 2 when 'sectional' then 3 end * 10000
       + coalesce(p_no, 0) * 10 + case when p_part = 'post' then 1 else 0 end;
$$;

-- The quiz a student must submit before this one, or null (first in its week, or not part of a week).
create or replace function public._week_prev(p_quiz uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select y.id
  from quizzes z
  join quizzes y on y.program = z.program and y.batch is not distinct from z.batch and y.week_no = z.week_no
                and y.id <> z.id and y.day_type in ('core', 'challenge', 'surprise', 'sectional')
                and _week_rank(y.day_type, y.day_no, y.part) < _week_rank(z.day_type, z.day_no, z.part)
  where z.id = p_quiz and z.week_no is not null and z.day_type in ('core', 'challenge', 'surprise', 'sectional')
  order by _week_rank(y.day_type, y.day_no, y.part) desc, y.created_at desc
  limit 1;
$$;

-- "Core Day 2 Pre-quiz", "Challenge Day 1 Quiz", "Surprise Day 1 Pre-quiz", "Week 3 Sectional"
create or replace function public._week_label(p_quiz uuid) returns text
language sql stable security definer set search_path = public as $$
  select case z.day_type
           when 'sectional' then 'Week ' || z.week_no || ' Sectional'
           else initcap(z.day_type) || ' Day ' || coalesce(z.day_no, 1) || case when z.part = 'post' then ' Quiz' else ' Pre-quiz' end
         end
  from quizzes z where z.id = p_quiz;
$$;

-- Checked on every new attempt, so no route can skip it.
create or replace function public._check_week_order() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_prev uuid;
begin
  v_prev := _week_prev(new.quiz_id);
  if v_prev is not null and not exists (
       select 1 from attempts a where a.quiz_id = v_prev and lower(a.email) = lower(new.email) and a.status = 'submitted') then
    raise exception 'LOCKED_PREVIOUS: %', _week_label(v_prev);
  end if;
  return new;
end $$;

drop trigger if exists attempts_week_order on public.attempts;
create trigger attempts_week_order before insert on public.attempts
  for each row execute function public._check_week_order();

revoke all on function public._week_prev(uuid) from public, anon, authenticated;
revoke all on function public._week_label(uuid) from public, anon, authenticated;

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
          'code', z.code, 'program', z.program,
          -- a scheduled Surprise Day stays a surprise: no title, time or size until it goes live
          'title', case when z.day_type = 'surprise' and z.status = 'draft' then null else z.title end,
          'week_no', z.week_no, 'day_type', z.day_type, 'day_no', z.day_no, 'part', z.part,
          'batch', z.batch, 'topic', coalesce(z.topic, 'Other'),
          'status', z.status,
          'starts_at', case when z.status = 'draft' and z.day_type is distinct from 'surprise' then z.starts_at end,
          'ends_at', case when z.status = 'live' then z.ends_at end,
          'opened_at', case when z.day_type = 'surprise' and z.status = 'draft' then z.created_at else coalesce(z.started_at, z.starts_at, z.created_at) end,
          'duration_minutes', case when z.day_type = 'surprise' and z.status = 'draft' then null else z.duration_minutes end,
          'question_count', case when z.day_type = 'surprise' and z.status = 'draft' then null else (select count(*) from questions x where x.quiz_id = z.id) end,
          'practice', z.allow_practice,
          -- the earlier quiz of this week they still have to submit before this one opens
          'needs', (select _week_label(pv.id) from (select _week_prev(z.id) as id) pv
                    where pv.id is not null and not exists (
                      select 1 from attempts a3 where a3.quiz_id = pv.id and lower(a3.email) = any (v_emails) and a3.status = 'submitted')),
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
        -- drafts show when scheduled, or as locked when they belong to a week
        and (z.status in ('live', 'ended') or (z.status = 'draft' and (z.starts_at is not null or (z.week_no is not null and z.day_type is not null))))
        and (z.access = 'open'
             or exists (select 1 from quiz_invites i where i.quiz_id = z.id and i.email = any (v_emails))
             or exists (select 1 from attempts m where m.quiz_id = z.id and lower(m.email) = any (v_emails)))
    ), '[]'::jsonb));
end $$;

grant execute on function public.my_library(jsonb) to anon, authenticated;

notify pgrst, 'reload schema';

-- ================= v13: LRDI sets, images and tables (same as patch_sets.sql) =================
-- GRADQUIZ patch: LRDI sets, images, charts and tables. Run once in the Supabase SQL Editor, after patch_weeks.sql.
-- Safe to run again.
-- A set is a shared passage (directions, data, a chart or a table) that several questions use. Students see the
-- passage beside the question. Images are stored in the public Storage bucket quiz-images (only admins can upload)
-- and are written into any text as a line like  ![](https://...)  . Tables are written as | a | b | rows.

alter table public.questions add column if not exists set_no int;
alter table public.questions add column if not exists set_body text;
alter table public.questions drop constraint if exists questions_set_check;
alter table public.questions add constraint questions_set_check check (
  (set_no is null and set_body is null) or (set_no between 1 and 500 and set_body is not null));

-- ---------- images: public bucket, admins upload ----------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('quiz-images', 'quiz-images', true, 5242880, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists quiz_images_admin_read on storage.objects;
create policy quiz_images_admin_read on storage.objects for select to authenticated
  using (bucket_id = 'quiz-images' and public.is_admin());
drop policy if exists quiz_images_admin_insert on storage.objects;
create policy quiz_images_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'quiz-images' and public.is_admin());
drop policy if exists quiz_images_admin_update on storage.objects;
create policy quiz_images_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'quiz-images' and public.is_admin());
drop policy if exists quiz_images_admin_delete on storage.objects;
create policy quiz_images_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'quiz-images' and public.is_admin());

-- ---------- students get the set passage with each question ----------

create or replace function public._questions_json(p_quiz uuid) returns jsonb
language sql stable security definer set search_path = public as $$
select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'body', body, 'options', options,
                                             'set_no', set_no, 'set_body', set_body) order by position), '[]'::jsonb)
from questions where quiz_id = p_quiz;
$$;

create or replace function public._attempt_questions_json(p_attempt uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', z.id, 'kind', z.kind, 'body', z.body, 'options', z.options,
      'set_no', z.set_no, 'set_body', z.set_body,
      'opt_map', a.opt_order -> z.id::text)
    order by coalesce(array_position(a.q_order, z.id), 0), z.position), '[]'::jsonb)
  from attempts a join questions z on z.quiz_id = a.quiz_id
  where a.id = p_attempt;
$$;

-- Shuffling keeps the questions of a set together and in their own order; sets and single questions move as blocks.
create or replace function public._attempt_shuffle() returns trigger
language plpgsql security definer set search_path = public as $$
declare q quizzes%rowtype;
begin
  select * into q from quizzes where id = new.quiz_id;
  if q.shuffle_questions then
    new.q_order := (
      select array_agg(z.id order by b.r, z.position)
      from questions z
      join (select k, random() as r
            from (select distinct coalesce('s' || x.set_no, x.id::text) as k from questions x where x.quiz_id = new.quiz_id) d) b
        on b.k = coalesce('s' || z.set_no, z.id::text)
      where z.quiz_id = new.quiz_id);
  end if;
  if q.shuffle_options then
    new.opt_order := (
      select jsonb_object_agg(z.id::text,
        (select jsonb_agg(i order by random()) from generate_series(0, jsonb_array_length(z.options) - 1) i))
      from questions z where z.quiz_id = new.quiz_id and z.kind = 'mcq');
  end if;
  return new;
end $$;

-- review and practice carry the passage too
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
          'set_no', z.set_no,
          'set_body', z.set_body,
          'opt_map', a.opt_order -> z.id::text,
          'your', a.answers -> z.id::text,
          'correct', case when z.kind = 'mcq' then to_jsonb(z.correct_index) else to_jsonb(z.accepted) end,
          'ok', a.graded -> z.id::text,
          'bonus', z.bonus,
          'time', a.times -> z.id::text,
          'avg_time', (select round(avg((t.times ->> z.id::text)::numeric)) from attempts t
                        where t.quiz_id = z.quiz_id and t.status = 'submitted' and t.times ? z.id::text),
          'explanation', z.explanation)
        order by coalesce(array_position(a.q_order, z.id), 0), z.position), '[]'::jsonb)
      from questions z where z.quiz_id = q.id));
end $$;

create or replace function public.practice_check(p_code text, p_answers jsonb, p_attempt uuid default null, p_token uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_quiz uuid; q quizzes%rowtype; r record; given jsonb; ok boolean;
  c int := 0; wm int := 0; wt int := 0; u int := 0;
  items jsonb := '[]'::jsonb;
begin
  v_quiz := _practice_quiz(p_code, p_attempt, p_token);
  select * into q from quizzes where id = v_quiz;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then p_answers := '{}'::jsonb; end if;

  for r in select * from questions where quiz_id = v_quiz order by position loop
    given := p_answers -> r.id::text;
    -- keep only a valid answer
    if r.kind = 'mcq' then
      if not (jsonb_typeof(given) = 'number' and (given #>> '{}') ~ '^[0-9]{1,2}$'
              and (given #>> '{}')::int < jsonb_array_length(r.options)) then given := null; end if;
    else
      if jsonb_typeof(given) = 'string' and btrim(given #>> '{}') <> '' then given := to_jsonb(left(btrim(given #>> '{}'), 40));
      else given := null; end if;
    end if;

    if r.bonus then ok := true;
    elsif given is null then ok := null;
    elsif r.kind = 'mcq' then ok := (given #>> '{}')::int = r.correct_index;
    else ok := _tita_match(given #>> '{}', r.accepted);
    end if;

    if ok is null then u := u + 1;
    elsif ok then c := c + 1;
    elsif r.kind = 'mcq' then wm := wm + 1;
    else wt := wt + 1;
    end if;

    items := items || jsonb_build_array(jsonb_build_object(
      'id', r.id, 'kind', r.kind, 'body', r.body, 'options', r.options,
      'set_no', r.set_no, 'set_body', r.set_body,
      'your', given,
      'correct', case when r.kind = 'mcq' then to_jsonb(r.correct_index) else to_jsonb(r.accepted) end,
      'ok', ok, 'bonus', r.bonus, 'explanation', r.explanation,
      'avg_time', (select round(avg((t.times ->> r.id::text)::numeric)) from attempts t
                    where t.quiz_id = v_quiz and t.status = 'submitted' and t.times ? r.id::text)));
  end loop;

  return jsonb_build_object(
    'title', q.title,
    'score', c * q.marks_correct - wm * q.marks_wrong - wt * q.marks_wrong_tita,
    'total_marks', (select count(*) from questions where quiz_id = v_quiz) * q.marks_correct,
    'correct', c, 'wrong', wm + wt, 'unattempted', u,
    'items', items);
end $$;

notify pgrst, 'reload schema';


-- ================= v14: email code once per device (same as patch_device.sql) =================
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

-- ---------- after running this file ----------
-- 1. Supabase dashboard > Authentication > Users > Add user (your email + password).
-- 2. Then run this with your email to make that user an admin.
--    insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';
-- 3. Authentication > Providers > Email > turn OFF "Allow new users to sign up".
-- 4. Run cron.sql once so timed-out attempts close on their own.
-- 5. For Invited only quizzes set the Netlify variables listed in netlify/functions/send-otp.mjs.