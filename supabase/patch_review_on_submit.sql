-- GRADQUIZ patch. Run once in the Supabase SQL Editor.
-- Answer review opens for each student right after they submit (when "Let students review" is on for the quiz).
-- Before this it waited for the quiz to end and every student to finish.

create or replace function public._review_open(p_quiz uuid) returns boolean
language sql stable security definer set search_path = public as $$
select q.show_review from quizzes q where q.id = p_quiz;
$$;

revoke all on function public._review_open(uuid) from public, anon, authenticated;
