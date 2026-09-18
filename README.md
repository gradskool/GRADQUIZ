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
