import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { check, supabase } from '../../lib/supabase.js'
import { LETTERS, copyText, downloadCsv, formatWhen, num, spoken } from '../../lib/util.js'
import { useToast } from '../../components/Toast.jsx'
import QuizControls from '../../components/QuizControls.jsx'

const keyText = (q) => (q.kind === 'tita' ? q.accepted.join(' or ') : LETTERS[q.correct_index])
const givenText = (q, a) => (a == null ? '' : q.kind === 'tita' ? String(a) : LETTERS[a])

export default function Results() {
  const { id } = useParams()
  const toast = useToast()
  const [quiz, setQuiz] = useState(null)
  const [qs, setQs] = useState([])
  const [rows, setRows] = useState([])
  const [err, setErr] = useState('')
  const [sort, setSort] = useState({ key: 'score', dir: 'desc' })
  const [open, setOpen] = useState(() => new Set())
  const [stamp, setStamp] = useState(null)

  const load = useCallback(async () => {
    try {
      await supabase.rpc('finalize_expired', { p_quiz: id })
      const q = check(await supabase.from('quizzes').select('*').eq('id', id).single())
      const questions = check(await supabase.from('questions').select('id, position, kind, body, options, correct_index, accepted').eq('quiz_id', id).order('position'))
      const attempts = check(await supabase.from('attempts').select('id, token, link_requested_at, name, email, status, submit_reason, started_at, submitted_at, answers, graded, correct, wrong, unattempted, score, time_taken_seconds').eq('quiz_id', id))
      setQuiz(q)
      setQs(questions)
      setRows(attempts)
      setStamp(new Date())
      setErr('')
    } catch (e) {
      setErr(e.message)
    }
  }, [id])

  useEffect(() => { load() }, [load])
  const stillWorking = rows.some((r) => r.status === 'in_progress')
  useEffect(() => {
    if (quiz?.status !== 'live' && !stillWorking) return
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
  }, [quiz?.status, stillWorking, load])

  async function submitAll(n) {
    if (!window.confirm(`Submit the ${n} ${n === 1 ? 'student' : 'students'} still working right now? Their saved answers are scored.`)) return
    try {
      check(await supabase.rpc('submit_all_in_progress', { p_quiz: id }))
      await load()
    } catch (e) {
      setErr(e.message)
    }
  }

  const submitted = rows.filter((r) => r.status === 'submitted')
  const total = quiz ? qs.length * Number(quiz.marks_correct) : 0

  const sorted = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1
    const val = (r) => {
      if (sort.key === 'name') return r.name.toLowerCase()
      if (sort.key === 'score') return r.score == null ? null : Number(r.score)
      if (sort.key === 'correct') return r.correct
      if (sort.key === 'time') return r.time_taken_seconds
      return null
    }
    return [...rows].sort((a, b) => {
      const x = val(a)
      const y = val(b)
      if (x == null && y == null) return 0
      if (x == null) return 1
      if (y == null) return -1
      if (x < y) return -1 * dir
      if (x > y) return 1 * dir
      if (sort.key === 'score') return (a.time_taken_seconds ?? 0) - (b.time_taken_seconds ?? 0)
      return 0
    })
  }, [rows, sort])

  const analysis = useMemo(() => qs.map((q) => {
    let right = 0
    let wrong = 0
    let skipped = 0
    for (const r of submitted) {
      const g = r.graded?.[q.id]
      if (g === true) right += 1
      else if (g === false) wrong += 1
      else skipped += 1
    }
    return { q, right, wrong, skipped }
  }), [qs, submitted])

  if (err && !quiz) return <main className="page"><p className="error" role="alert">{err}</p></main>
  if (!quiz) return <main className="page"><p className="muted">Loading.</p></main>

  const scores = submitted.map((r) => Number(r.score))
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null
  const best = scores.length ? Math.max(...scores) : null
  const times = submitted.map((r) => r.time_taken_seconds).filter((t) => t != null)
  const avgTime = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null
  const inProgress = rows.length - submitted.length

  const sortBy = (key) => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))
  const arrow = (key) => (sort.key === key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : '')
  const toggle = (rid) => setOpen((s) => { const n = new Set(s); n.has(rid) ? n.delete(rid) : n.add(rid); return n })

  const linkFor = (r) => `${window.location.origin}/q/${quiz.code}?a=${r.id}&t=${r.token}`

  function exportCsv() {
    const head = ['Name', 'Email', 'Status', 'Score', 'Correct', 'Wrong', 'Unattempted', 'Time taken (seconds)', 'Submitted at', 'How it ended', 'Result link', ...qs.map((_, i) => `Q${i + 1}`)]
    const body = sorted.map((r) => [
      r.name, r.email, r.status, r.score ?? '', r.correct ?? '', r.wrong ?? '', r.unattempted ?? '',
      r.time_taken_seconds ?? '', r.submitted_at ?? '', r.submit_reason ?? '', linkFor(r),
      ...qs.map((q) => givenText(q, r.answers?.[q.id])),
    ])
    const key = ['Answer key', '', '', '', '', '', '', '', '', '', '', ...qs.map((q) => keyText(q))]
    downloadCsv(`${quiz.code}-results.csv`, [head, key, ...body])
  }

  return (
    <main className="page">
      <p><Link to="/admin">All quizzes</Link> <span className="muted">/</span> <Link to={`/admin/quiz/${id}`}>{quiz.title}</Link></p>
      <div className="spacer" />
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1>Results</h1>
          <p style={{ marginTop: 10 }} className="row">
            <span className={`status ${quiz.status}`}><i />{quiz.status === 'draft' ? 'Draft' : quiz.status === 'live' ? 'Live' : 'Ended'}</span>
            <span className="codechip">{quiz.code}</span>
          </p>
        </div>
        <div className="stack" style={{ textAlign: 'right' }}>
          <QuizControls quiz={quiz} questionCount={qs.length} onChange={load} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn ghost small" onClick={load}>Refresh</button>
            <button className="btn small" onClick={exportCsv} disabled={rows.length === 0}>Download CSV</button>
          </div>
        </div>
      </div>
      {err && <p className="error" role="alert" style={{ marginTop: 12 }}>{err}</p>}
      {(quiz.status === 'live' || stillWorking) && stamp && <p className="muted small" style={{ marginTop: 12 }}>Updates every 10 seconds.</p>}

      <div className="spacer" />
      {quiz.status !== 'draft' && inProgress > 0 && (
        <div className="notice row between" style={{ marginBottom: 24 }}>
          <span>
            <b>{inProgress}</b> {inProgress === 1 ? 'student is' : 'students are'} still working.
            {quiz.status === 'ended' ? ' They keep their own timers and can finish.' : ''}
          </span>
          <button className="btn ghost small" onClick={() => submitAll(inProgress)}>Submit everyone still working</button>
        </div>
      )}
      <div className="stats">
        <div><b>{rows.length}</b><span className="muted">joined</span></div>
        <div><b>{submitted.length}</b><span className="muted">submitted</span></div>
        <div><b>{inProgress}</b><span className="muted">in progress</span></div>
        <div><b>{avg == null ? '-' : num(Math.round(avg * 100) / 100)}</b><span className="muted">average out of {num(total)}</span></div>
        <div><b>{best == null ? '-' : num(best)}</b><span className="muted">highest</span></div>
        <div><b>{avgTime == null ? '-' : spoken(avgTime)}</b><span className="muted">average time</span></div>
      </div>

      <section className="block">
        <h2>Students</h2>
        {rows.length === 0 ? (
          <div className="notice plain">No one has joined yet.</div>
        ) : (
          <div className="tablewrap">
            <table className="t">
              <thead>
                <tr>
                  <th><button onClick={() => sortBy('name')}>Name{arrow('name')}</button></th>
                  <th>Email</th>
                  <th className="n"><button onClick={() => sortBy('score')}>Score{arrow('score')}</button></th>
                  <th className="n"><button onClick={() => sortBy('correct')}>Right{arrow('correct')}</button></th>
                  <th className="n">Wrong</th>
                  <th className="n">Skipped</th>
                  <th className="n"><button onClick={() => sortBy('time')}>Time{arrow('time')}</button></th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <Fragment key={r.id}>
                    <tr>
                      <td><b>{r.name}</b>{r.link_requested_at && <span className="chip">Asked for link</span>}</td>
                      <td className="muted">{r.email}</td>
                      <td className="n"><b>{num(r.score)}</b></td>
                      <td className="n">{r.correct ?? '-'}</td>
                      <td className="n">{r.wrong ?? '-'}</td>
                      <td className="n">{r.unattempted ?? '-'}</td>
                      <td className="n">{r.time_taken_seconds == null ? '-' : spoken(r.time_taken_seconds)}</td>
                      <td>
                        {r.status === 'in_progress' ? 'In progress'
                          : r.submit_reason === 'manual' ? 'Submitted'
                          : r.submit_reason === 'time' ? 'Time ran out'
                          : 'Submitted by you'}
                      </td>
                      <td>
                        <div className="row" style={{ gap: 16, flexWrap: 'nowrap' }}>
                          <button className="link" onClick={() => toggle(r.id)} aria-expanded={open.has(r.id)}>{open.has(r.id) ? 'Hide' : 'Answers'}</button>
                          <button className="link" onClick={async () => {
                            await copyText(linkFor(r))
                            toast('Link copied')
                            if (r.link_requested_at) {
                              await supabase.from('attempts').update({ link_requested_at: null }).eq('id', r.id)
                              load()
                            }
                          }}>Copy link</button>
                        </div>
                      </td>
                    </tr>
                    {open.has(r.id) && (
                      <tr>
                        <td colSpan={9}>
                          <div className="answersheet">
                            {qs.map((q, i) => {
                              const a = r.answers?.[q.id]
                              const g = r.graded?.[q.id]
                              const cls = g === true ? 'r' : g === false ? 'w' : ''
                              return <span key={q.id} className={cls}>Q{i + 1} {a == null ? '-' : givenText(q, a)}{g === false ? ` (${keyText(q)})` : ''}</span>
                            })}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {submitted.length > 0 && (
        <section className="block">
          <h2>By question</h2>
          <p className="muted" style={{ marginBottom: 12 }}>Share of submitted students who got each question right.</p>
          <div className="tablewrap">
            <table className="t">
              <thead>
                <tr><th>Question</th><th>Right</th><th className="n">Wrong</th><th className="n">Skipped</th><th>Correct answer</th></tr>
              </thead>
              <tbody>
                {analysis.map(({ q, right, wrong, skipped }, i) => {
                  const pct = Math.round((right / submitted.length) * 100)
                  return (
                    <tr key={q.id}>
                      <td style={{ maxWidth: 380 }}><b>{i + 1}.</b> {q.body.length > 90 ? q.body.slice(0, 90) + '...' : q.body}</td>
                      <td><div className="bar-cell"><div className="meter"><i style={{ width: `${pct}%` }} /></div><span>{pct}%</span></div></td>
                      <td className="n">{wrong}</td>
                      <td className="n">{skipped}</td>
                      <td>{keyText(q)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <p className="muted small">Started {formatWhen(quiz.started_at)}{quiz.ended_at ? `. Ended ${formatWhen(quiz.ended_at)}.` : '.'}</p>
    </main>
  )
}