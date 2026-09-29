-- GRADQUIZ patch: LRDI sets, images, charts and tables. Run once in the Supabase SQL Editor, after patch_weeks.sql.
-- Safe to run again.
-- A set is a shared passage (directions, data, a chart or a table) that several questions use. Students see the
-- passage beside the question. Images are stored in the public Storage bucket quiz-images (only admins can upload)
-- and are written into any text as a line like  ![](https://...)  . Tables are written as | a | b | rows.
-- After submitting, students with scores shown see how they did on each set. A quiz can show an on-screen
-- calculator (like CAT's) while it is taken.

alter table public.questions add column if not exists set_no int;
alter table public.questions add column if not exists set_body text;
alter table public.questions drop constraint if exists questions_set_check;
alter table public.questions add constraint questions_set_check check (
  (set_no is null and set_body is null) or (set_no between 1 and 500 and set_body is not null));

alter table public.quizzes add column if not exists calculator boolean not null default false;

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

-- ---------- set results and the calculator flag ----------

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
      'calculator', q.calculator,
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
    'practice_available', q.allow_practice,
    -- LRDI: how the student did on each set, in the order they saw the sets
    'sets', case when q.show_score and exists (select 1 from questions x where x.quiz_id = q.id and x.set_no is not null) then (
      select jsonb_agg(jsonb_build_object(
          'set_no', g.set_no, 'n', g.n, 'tried', g.tried, 'correct', g.correct, 'time', g.secs,
          'class_correct', (
            select round(avg(c.k), 1) from (
              select count(*) filter (where (t.graded ->> z2.id::text)::boolean) as k
              from attempts t join questions z2 on z2.quiz_id = t.quiz_id and z2.set_no is not distinct from g.set_no
              where t.quiz_id = q.id and t.status = 'submitted' group by t.id) c))
        order by g.first)
      from (
        select z.set_no,
               min(coalesce(array_position(a.q_order, z.id), z.position)) as first,
               count(*) as n,
               count(*) filter (where a.answers ? z.id::text) as tried,
               count(*) filter (where (a.graded ->> z.id::text)::boolean) as correct,
               coalesce(sum((a.times ->> z.id::text)::numeric), 0) as secs
        from questions z where z.quiz_id = q.id group by z.set_no) g) end);
end $$;

create or replace function public.practice_questions(p_code text, p_attempt uuid default null, p_token uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_quiz uuid; q quizzes%rowtype;
begin
  v_quiz := _practice_quiz(p_code, p_attempt, p_token);
  select * into q from quizzes where id = v_quiz;
  return jsonb_build_object(
    'title', q.title,
    'calculator', q.calculator,
    'marks_correct', q.marks_correct, 'marks_wrong', q.marks_wrong, 'marks_wrong_tita', q.marks_wrong_tita,
    'questions', _questions_json(v_quiz));
end $$;

notify pgrst, 'reload schema';
