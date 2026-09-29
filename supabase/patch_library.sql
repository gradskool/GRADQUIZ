-- GRADQUIZ patch: student library. Run once in the Supabase SQL Editor. Safe to run again.
-- Each quiz can have a batch and a topic, and can be shown in the library.
-- Any student who has found themselves (a valid attempt secret on their device) sees every library quiz,
-- tabbed by batch: live quizzes (can attempt), scheduled ones (coming up), and ended ones (their result,
-- or "missed"). Invited only quizzes show only to invited emails. Nobody can attempt an ended quiz from here.

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
