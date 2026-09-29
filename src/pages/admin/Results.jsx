import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { check, rpc, supabase } from '../../lib/supabase.js'
import { plainText } from '../../components/RichText.jsx'
import { LETTERS, copyText, downloadCsv, formatWhen, num, spoken } from '../../lib/util.js'
import { useToast } from '../../components/Toast.jsx'
import QuizControls from '../../components/QuizControls.jsx'

const keyText = (q) => (q.bonus ? 'Bonus' : q.kind === 'tita' ? q.accepted.join(' or ') : LETTERS[q.correct_index])
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
  const [invites, setInvites] = useState([])
  const [newPin, setNewPin] = useState(null)

  const load = useCallback(async () => {
    try {
      await supabase.rpc('finalize_expired', { p_quiz: id })
      const q = check(await supabase.from('quizzes').select('*').eq('id', id).single())
      const questions = check(await supabase.from('questions').select('id, position, kind, body, options, correct_index, accepted, bonus').eq('quiz_id', id).order('position'))
      const attempts = check(await supabase.from('attempts').select('id, token, link_requested_at, name, email, status, submit_reason, started_at, submitted_at, answers, graded, correct, wrong, unattempted, score, time_taken_seconds, times, tab_switches, away_seconds').eq('quiz_id', id))
      const inv = check(await supabase.from('quiz_invites').select('email').eq('quiz_id', id).order('email'))
      setQuiz(q)
      setQs(questions)
      setRows(attempts)
      setInvites(inv.map((r) => r.email))
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

  async function resetPin(r) {
    if (!window.confirm(`Give ${r.name} a new PIN? Their old PIN stops working.`)) return
    try {
      const pin = await rpc('admin_reset_pin', { p_attempt: r.id })
      setNewPin({ name: r.name, email: r.email, pin })
      load()
    } catch (e) {
      setErr(e.message)
    }
  }

  async function adminReport(attemptId) {
    try {
      const [d, { buildReport }] = await Promise.all([rpc('admin_report', { p_attempt: attemptId }), import('../../lib/report.js')])
      buildReport(d, { admin: true })
    } catch (e) {
      setErr(e.message)
    }
  }

  async function submitAll(n) {
    if (!window.confirm(`Submit the ${n} ${n === 1 ? 'student' : 'students'} still working right now? Their saved answers are scored.`)) return
    try {
      check(await supabase.rpc('submit_all_in_progress', { p_quiz: id }))
      await load()
    } catch (e) {
      setErr(e.message)
    }
  }

  const submitted = useMemo(() => rows.filter((r) => r.status === 'submitted'), [rows])
  const total = quiz ? qs.length * Number(quiz.marks_correct) : 0
  // Rank counts students with a higher score, like the student sees it.
  const rankOf = useMemo(() => {
    const scores = submitted.map((r) => Number(r.score))
    const m = new Map()
    for (const r of submitted) m.set(r.id, 1 + scores.filter((x) => x > Number(r.score)).length)
    return m
  }, [submitted])
  const pctOf = (r) => {
    if (!rankOf.has(r.id)) return null
    const me = Number(r.score)
    return (100 * submitted.filter((x) => Number(x.score) <= me).length) / submitted.length
  }
  const notStarted = useMemo(() => {
    const joined = new Set(rows.map((r) => r.email.toLowerCase()))
    return invites.filter((e) => !joined.has(e))
  }, [invites, rows])

  const sorted = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1
    const val = (r) => {
      if (sort.key === 'name') return r.name.toLowerCase()
      if (sort.key === 'score') return r.score == null ? null : Number(r.score)
      if (sort.key === 'correct') return r.correct
      if (sort.key === 'time') return r.time_taken_seconds
      if (sort.key === 'tabs') return r.tab_switches ?? 0
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
    let tSum = 0
    let tN = 0
    for (const r of submitted) {
      const g = r.graded?.[q.id]
      if (g === true) right += 1
      else if (g === false) wrong += 1
      else skipped += 1
      const t = r.times?.[q.id]
      if (t != null) { tSum += Number(t); tN += 1 }
    }
    return { q, right, wrong, skipped, avgTime: tN ? tSum / tN : null }
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


  function exportCsv() {
    const head = ['Name', 'Email', 'Status', 'Rank', 'Percentile', 'Score', 'Correct', 'Wrong', 'Unattempted', 'Time taken (seconds)', 'Tab switches', 'Seconds away', 'Submitted at', 'How it ended',
      ...qs.map((_, i) => `Q${i + 1}`), ...qs.map((_, i) => `Q${i + 1} seconds`)]
    const body = sorted.map((r) => [
      r.name, r.email, r.status, rankOf.get(r.id) ?? '', pctOf(r) == null ? '' : Math.round(pctOf(r) * 100) / 100,
      r.score ?? '', r.correct ?? '', r.wrong ?? '', r.unattempted ?? '',
      r.time_taken_seconds ?? '', r.tab_switches ?? 0, r.away_seconds ?? 0, r.submitted_at ?? '', r.submit_reason ?? '',
      ...qs.map((q) => givenText(q, r.answers?.[q.id])), ...qs.map((q) => r.times?.[q.id] ?? ''),
    ])
    const key = ['Answer key', '', '', '', '', '', '', '', '', '', '', '', '', '', ...qs.map((q) => keyText(q))]
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
                  <th className="n">#</th>
                  <th><button onClick={() => sortBy('name')}>Name{arrow('name')}</button></th>
                  <th>Email</th>
                  <th className="n"><button onClick={() => sortBy('score')}>Score{arrow('score')}</button></th>
                  <th className="n"><button onClick={() => sortBy('correct')}>Right{arrow('correct')}</button></th>
                  <th className="n">Wrong</th>
                  <th className="n">Skipped</th>
                  <th className="n"><button onClick={() => sortBy('time')}>Time{arrow('time')}</button></th>
                  <th className="n"><button onClick={() => sortBy('tabs')}>Tabs{arrow('tabs')}</button></th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <Fragment key={r.id}>
                    <tr>
                      <td className="n">{rankOf.get(r.id) ?? '-'}</td>
                      <td><Link to={`/admin/students/${encodeURIComponent(r.email.toLowerCase())}`}><b>{r.name}</b></Link>{r.link_requested_at && <span className="chip">Asked for help</span>}</td>
                      <td className="muted">{r.email}</td>
                      <td className="n"><b>{num(r.score)}</b></td>
                      <td className="n">{r.correct ?? '-'}</td>
                      <td className="n">{r.wrong ?? '-'}</td>
                      <td className="n">{r.unattempted ?? '-'}</td>
                      <td className="n">{r.time_taken_seconds == null ? '-' : spoken(r.time_taken_seconds)}</td>
                      <td className="n" title={r.away_seconds ? `${spoken(r.away_seconds)} away from the quiz tab` : 'Stayed on the quiz tab'}>
                        {r.tab_switches ? <span className={r.away_seconds >= 60 ? 'noc' : ''}>{r.tab_switches}<small className="muted"> · {spoken(r.away_seconds)}</small></span> : '0'}
                      </td>
                      <td>
                        {r.status === 'in_progress' ? 'In progress'
                          : r.submit_reason === 'manual' ? 'Submitted'
                          : r.submit_reason === 'time' ? 'Time ran out'
                          : 'Submitted by you'}
                      </td>
                      <td>
                        <div className="row" style={{ gap: 16, flexWrap: 'nowrap' }}>
                          <button className="link" onClick={() => toggle(r.id)} aria-expanded={open.has(r.id)}>{open.has(r.id) ? 'Hide' : 'Answers'}</button>
                          {r.status === 'submitted' && <button className="link" onClick={() => adminReport(r.id)}>Report</button>}
                          <button className="link" onClick={() => resetPin(r)}>Reset PIN</button>
                        </div>
                      </td>
                    </tr>
                    {open.has(r.id) && (
                      <tr>
                        <td colSpan={11}>
                          <div className="answersheet">
                            {qs.map((q, i) => {
                              const a = r.answers?.[q.id]
                              const g = r.graded?.[q.id]
                              const cls = g === true ? 'r' : g === false ? 'w' : ''
                              const t = r.times?.[q.id]
                              return <span key={q.id} className={cls}>Q{i + 1} {a == null ? '-' : givenText(q, a)}{g === false ? ` (${keyText(q)})` : ''}{t != null && <small className="muted"> {spoken(t)}</small>}</span>
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

      {quiz.access === 'invited' && (
        <section className="block">
          <div className="row between">
            <h2 style={{ marginBottom: 0 }}>Invited, not started ({notStarted.length} of {invites.length})</h2>
            {notStarted.length > 0 && (
              <button className="btn ghost small" onClick={async () => { await copyText(notStarted.join('\n')); toast('Emails copied') }}>Copy emails</button>
            )}
          </div>
          {notStarted.length === 0
            ? <p className="muted" style={{ marginTop: 8 }}>{invites.length ? 'Every invited student has started.' : 'The invite list is empty.'}</p>
            : <ul className="invites" style={{ marginTop: 12 }}>{notStarted.map((e) => <li key={e}><span>{e}</span></li>)}</ul>}
        </section>
      )}

      {submitted.length > 0 && (
        <section className="block">
          <h2>By question</h2>
          <p className="muted" style={{ marginBottom: 12 }}>Share of submitted students who got each question right, and the average time spent on it. To fix a key or make a question a bonus, open the quiz and use Change answer key.</p>
          <div className="tablewrap">
            <table className="t">
              <thead>
                <tr><th>Question</th><th>Right</th><th className="n">Wrong</th><th className="n">Skipped</th><th className="n">Avg time</th><th>Correct answer</th></tr>
              </thead>
              <tbody>
                {analysis.map(({ q, right, wrong, skipped, avgTime }, i) => {
                  const pct = Math.round((right / submitted.length) * 100)
                  return (
                    <tr key={q.id}>
                      <td style={{ maxWidth: 380 }}><b>{i + 1}.</b> {(() => { const t = plainText(q.body).replace(/\s+/g, ' '); return t.length > 90 ? t.slice(0, 90) + '...' : t })()}</td>
                      <td><div className="bar-cell"><div className="meter"><i style={{ width: `${pct}%` }} /></div><span>{pct}%</span></div></td>
                      <td className="n">{wrong}</td>
                      <td className="n">{skipped}</td>
                      <td className="n">{avgTime == null ? '-' : spoken(avgTime)}</td>
                      <td>{keyText(q)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {newPin && (
        <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="pin-h">
          <div className="dialog">
            <h2 id="pin-h">New PIN for {newPin.name}</h2>
            <p className="score" style={{ marginTop: 8, letterSpacing: '0.12em' }}>{newPin.pin}</p>
            <p>Tell the student to open the quiz page, choose Find your result, and enter <b>{newPin.email}</b> with this PIN. They can change it from their result page. This PIN is not shown again.</p>
            <div className="row">
              <button className="btn" autoFocus onClick={async () => {
                await copyText(`GRADQUIZ ${quiz.title}: your new PIN is ${newPin.pin}. Open ${window.location.origin}/q/${quiz.code}, choose Find your result, and enter ${newPin.email} with this PIN.`)
                toast('Message copied')
              }}>Copy message</button>
              <button className="btn ghost" onClick={() => setNewPin(null)}>Done</button>
            </div>
          </div>
        </div>
      )}
      <p className="muted small">Started {formatWhen(quiz.started_at)}{quiz.ended_at ? `. Ended ${formatWhen(quiz.ended_at)}.` : '.'}</p>
    </main>
  )
}