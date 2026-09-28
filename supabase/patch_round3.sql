-- GRADQUIZ patch, round 3. Run once in the Supabase SQL Editor, AFTER patch_invited_only.sql. Safe to run again.
-- Run this BEFORE deploying the new site. The new site sends extra data that only these functions accept.
--
-- 1. Fix the answer key after a quiz starts, or mark a question as a bonus. Every submitted attempt is re-scored.
-- 2. Rank and percentile on the student result, optional top 10 leaderboard.
-- 3. Time spent on each question, tab switches and time away from the quiz tab.
-- 4. Scheduled start and scheduled close of entry.
-- 5. Shuffle questions and options per student.
-- 6. Student history across quizzes for the admin.

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

  v_otp := lpad(((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');

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
