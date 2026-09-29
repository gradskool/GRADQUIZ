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
