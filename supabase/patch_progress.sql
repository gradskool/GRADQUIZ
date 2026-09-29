-- GRADQUIZ patch: student progress across quizzes. Run once in the Supabase SQL Editor. Safe to run again.
-- The student's page sends the attempt ids and secrets it holds (saved on the device, or found with email + PIN).
-- Only attempts whose secret matches are returned, and only for quizzes that show scores.

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
