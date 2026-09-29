# GRADQUIZ

A GRADSKOOL product. You build quizzes in an admin panel. Students enter a code and attempt the quiz.

Stack is React, Vite, Supabase and Netlify.

## How it works

1. Press New quiz. It gets a 6 character code.
2. Set the time and marking. Add questions one by one or paste many.
3. Press Start quiz. Share the code or the link `/q/CODE` in class.
4. Students enter name and email. Each student gets their own timer.
5. Press End quiz when class is over. Anyone still working is submitted with the answers saved so far.
6. Open Results for scores, time taken, answers and a CSV download.

## Question types

- **Multiple choice.** 2 to 6 options, one correct. A wrong answer loses the marks you set.
- **Type-in (TITA).** The student types the answer. You list the accepted answers. A wrong answer loses nothing by default. Change that in Settings if you want.
- Numbers match by value, so 42, 42.0 and +42 all count, and 1,000 matches 1000. Fractions are not converted, so list 3.5 and 7/2 both if you accept both.
- Text ignores capitals and extra spaces.

## Rules built in

- One attempt per email per quiz.
- Answer keys never leave the server. Scoring is done in the database.
- The timer is enforced on the server. Refreshing or editing the page does not help.
- Answers autosave after every click. A closed tab can be reopened on the same device to continue.
- Code, time, marking and questions lock once a quiz starts.
- Timed out attempts are submitted automatically.

## Setup (about 15 minutes)

### 1. Supabase

1. Create a project at supabase.com.
2. Open SQL Editor, paste all of `supabase/schema.sql` and run it.
3. Go to Authentication, then Users, then Add user. Use your email and a strong password.
4. Back in SQL Editor run this with your email.

```sql
insert into public.admins (user_id)
select id from auth.users where email = 'you@example.com';
```

5. Go to Authentication, Providers, Email. Turn off Allow new users to sign up.
6. Go to Project Settings, API. Copy the Project URL and the anon public key.
7. Run `supabase/cron.sql` in the SQL Editor. It closes timed-out attempts every minute. If it errors, turn on pg_cron under Database, Extensions, then run it again.

### 2. Run it locally

```bash
cp .env.example .env
# put the URL and anon key in .env
npm install
npm run dev
```

Open http://localhost:5173/admin and sign in.

### 3. Deploy on Netlify

1. Push this folder to GitHub.
2. New site from Git on Netlify. Build command `npm run build`. Publish directory `dist`.
3. Add the environment variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
4. Deploy. Add a custom domain such as quiz.gradskool.in if you like.

## Invited only quizzes

In a quiz's Settings choose **Invited only**, save, then paste the allowed emails into the Invite list (one per line, commas, or a column straight from a sheet). Students on the list enter name, email and PIN, press **Send code to my email**, and type the 6 digit code to start. Codes last 10 minutes, a new one can be asked for after 60 seconds, and 5 wrong tries need a new code. The Results page lists invited students who have not started.

One time setup:
1. Run `supabase/patch_invited_only.sql` in the SQL Editor (already inside `schema.sql` for new installs).
2. On the Gmail account that sends codes, turn on 2-Step Verification, then create an App password at myaccount.google.com/apppasswords.
3. In Netlify, Site configuration, Environment variables, add these with Functions in their scope, then redeploy.
   - `SUPABASE_SERVICE_ROLE_KEY` from Supabase, Project Settings, API. Never give it a `VITE_` prefix, that would put it in the website.
   - `GMAIL_USER` the Gmail address.
   - `GMAIL_APP_PASSWORD` the 16 character app password.
   - `SUPABASE_URL` is optional, `VITE_SUPABASE_URL` is used when it is missing.

A normal Gmail account sends about 500 emails a day. `npm run dev` does not run the email function, use `netlify dev` to test codes locally.

## Round 3 features

- **Fix the key after start.** On a started quiz each question has Change answer key. Pick the right option or edit accepted answers, or tick Bonus to give everyone full marks. Every submitted attempt is re-scored at once.
- **Rank and percentile.** Students see their rank and percentile under the score when scores are shown. Percentile is the share of submitted students at or below their score. Tick "Show the top 10" for a leaderboard. The result page refreshes every 30 seconds.
- **CAT palette.** Answered, not answered, not visited, marked for review, and answered and marked (these are scored). Mark for review & next, Save & next.
- **Time per question.** Stored per attempt. Results show average time per question, the answer sheet shows each student's time, students see their time and the class average in the review. Also in the CSV.
- **Schedule.** Start automatically at, and Close entry at. Closing entry works like End quiz. Schedules run when anyone opens the quiz and every minute through the cron job.
- **Shuffle and tabs.** Shuffle questions and options per student. Tab switches and time away are recorded and shown in Results and the CSV.
- **Students.** Admin, Students lists everyone by email. Open one for every quiz they took with score, rank, percentile and a percentile trend.

Run `supabase/patch_round3.sql` before deploying these pages.

## Round 4 features

- **Top 3.** The leaderboard shows the top 3 by name.
- **Maths.** Write maths between $ signs in questions, options and explanations: `$\frac{3}{4}$`, `$x^2$`, `$\sqrt{5}$`. Use `$$ ... $$` for a line of its own. Money like $5 and $10 stays plain text. Write `\$` for a literal dollar sign. The question form shows a live preview.
- **Practice.** Tick "Let students practise again". After submitting, a student can practise untimed, and the score is never saved, so their first score and rank stay. Only students who attempted can practise.
- **PDF report.** Students press Download report on their result (needs the score to be shown; answers appear only when review is open). Admins press Report next to any submitted student in Results or on the Students page.

Run `supabase/patch_round4.sql` before deploying these pages.

## Student progress

On the home page, Your results shows Your progress: quizzes taken, average percentile, average score, accuracy, best rank, how often they beat the class average, and a percentile trend. It covers every quiz on that device, plus any found with email and PIN. Each result page also shows the average percentile across their quizzes. Run `supabase/patch_progress.sql` once.

## Reopen, Reset PIN

- Ended quizzes have Reopen quiz. New students can start again; earlier attempts keep their scores. A Close entry time is cleared.
- Results has Reset PIN per student. It shows a new 4 digit PIN once, with a message to copy. Personal links are no longer shown anywhere.

## Student library

Give each quiz a Batch and a Topic in Settings, and leave "Show in the students' library" on. Students open Your library from the home page. They see every batch as a tab, with topics collapsed with "x of y done". Done quizzes open their result (and practice if on), missed ones show as missed, and ended quizzes cannot be attempted. A new device first needs Find all my results with email and PIN. When anything is live or scheduled, a Live now tab comes first and opens by default, listing live quizzes from every batch (Start from there) and Starting soon. The home page shows a Live now banner that links to it. Both refresh every minute. Run `supabase/patch_library.sql` once.

## Admin quiz list

Quizzes are grouped like the student library: a Live & upcoming tab (live and scheduled, only when there are any), Drafts, one tab per batch with topics collapsed and All / Live / Draft / Ended filters, and No batch. Search covers every quiz by title, code, batch or topic. The list refreshes every minute.

## Programs (FYQ, LRDI)

Every quiz belongs to a program (Program field in quiz Settings; existing quizzes are FYQ). Admin › Programs lists them. FYQ is open to anyone with the code. LRDI is listed students only: paste emails there, and only those emails can start LRDI quizzes; students cannot add themselves. The student library shows only their programs (every list they are on, plus any open program they attempted in), with an FYQ | LRDI switch for students on both. The admin quiz list has the same switch. Run `supabase/patch_programs.sql` once.

## Weeks and days (LRDI)

A week (named by its Topic) has Core, Challenge and Surprise days in any count (1-1-1, 2-2-2, 2-1-1...). Every day has a Pre-quiz; Core and Challenge days also have a Quiz; one Sectional per week. Extra sectionals sit outside weeks.

- **New week** (Quizzes page) makes the whole week as drafts: pick the counts, the first date, and it fills one day apart. Pre-quizzes start at 10:00 am, quizzes at 6:00 pm, the Sectional at the time you give. Running it again for the same week only adds missing days.
- **Order lock**: in a week each quiz opens for a student only after they submit the one before it (Core days, Challenge days, Surprise days, Sectional; Pre-quiz before Quiz). It is checked in the database on every start. A student who misses one that has ended stays locked for the rest of that week.
- **Week progress** (link under each week on the Quizzes page): every student against every quiz of the week, who is stuck and where, with Copy these emails.
- In quiz Settings a date under Schedule gets 10:00 am for a Pre-quiz and 6:00 pm for a Quiz; change it if needed.
- A scheduled Surprise day shows only as "revealed when it goes live" until it starts.

Run `supabase/patch_weeks.sql` once, after patch_programs.sql.

## LRDI sets, pictures and tables

- **Pictures**: in any question, set passage or explanation press Add image, paste a screenshot or drop a file. Several pictures with text between them are fine. They are stored in the Supabase Storage bucket `quiz-images` (made by the patch; only admins can upload).
- **Tables**: rows like `| Team | Won |`, with an optional `|---|---|` line under the heading.
- **Sets**: questions sharing one passage. Students see it beside the question (above it on phones), tap a chart to zoom. Shuffling keeps a set together.
- Paste many: start a set with `Set:` (or a Directions line), then the passage, then questions numbered `Q1.`, `Q2.`, and `End set`. A preview shows what will be added.
- Boxes with pictures, tables or maths show a live preview as you type.

Run `supabase/patch_sets.sql` once, after patch_weeks.sql.

## Email code once per device

For a listed-students program (like LRDI), tick "Email code once per device" under Programs. The first time a student starts one of its quizzes on a phone or computer, a 6 digit code is emailed (same Gmail setup as Invited only). That device is then trusted for that email for 60 days, so someone who only knows another student's email cannot start as them. "Forget devices" next to an email makes that student confirm again; removing a student forgets their devices. Run `supabase/patch_device.sql` once, after patch_sets.sql.

## Paste format for many questions

```
Q1. What is 15% of 240?
A) 24
B) 30
C) 36
D) 40
Ans: C

Q2. What is 6 x 7?
Ans: 42

Q3. Half of 7?
Ans: 3.5 | 7/2
```

A question with options needs a letter after Ans. A question without options is a type-in, and Ans is the value. Use a bar for more than one accepted answer.

## Upgrading from the first version

1. Run the new `supabase/schema.sql` in the SQL Editor. It upgrades in place. Existing quizzes, attempts and results are kept, and it is safe to run again.
2. Run `supabase/cron.sql` once.
3. Replace the changed files in `src` and redeploy.

## Good to know

- This is a shared code, so anyone who has the code can attempt. The email limit and the Start and End controls are the guard rails.
- Timed-out attempts are closed by the scheduled job within a minute. They are also closed the moment the student or the results page next loads, so results stay correct even if the job is off.
- There is no rate limit on joining. Add one at Supabase or Netlify if you ever open a code to the public.
- Supabase free projects pause after a week without traffic. Open the admin page once before a class after a long gap.
