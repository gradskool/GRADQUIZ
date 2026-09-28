-- GRADQUIZ patch, round 4. Run once in the Supabase SQL Editor, AFTER patch_round3.sql. Safe to run again.
-- Run this BEFORE deploying the new site.
--
-- 1. Leaderboard shows the top 3.
-- 2. Practice mode: students can attempt the quiz again, untimed and unranked. Their first score stays.
-- 3. PDF report data for a student (their own) and for the admin (anyone's).

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
    'practice', (q.allow_practice and q.status = 'ended' and q.access = 'open'),
    'duration_minutes', q.duration_minutes,
    'marks_correct', q.marks_correct,
    'marks_wrong', q.marks_wrong,
    'marks_wrong_tita', q.marks_wrong_tita,
    'question_count', n,
    'tita_count', t);
end $$;

-- ---------- 2. practice ----------

-- Who may practise: a student with their own submitted attempt, or anyone with the code once an open quiz has ended.
-- Invited only quizzes need the student's own attempt.
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
  if q.status = 'ended' and q.access = 'open' then return q.id; end if;
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
