-- GRADQUIZ fix: practice only for students who attempted. Run once in the Supabase SQL Editor.

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
revoke all on function public._practice_quiz(text, uuid, uuid) from public, anon, authenticated;

-- quiz_info no longer offers practice on the quiz page to people who did not attempt
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

notify pgrst, 'reload schema';
