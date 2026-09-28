import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { rpc } from '../../lib/supabase.js'
import { formatWhen, num, spoken } from '../../lib/util.js'

// One student's quizzes, newest first.
export default function StudentHistory() {
  const email = decodeURIComponent(useParams().email || '')
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    setRows(null)
    rpc('admin_student_history', { p_email: email }).then(setRows).catch((e) => setErr(e.message))
  }, [email])

  async function report(attemptId) {
    try {
      const [d, { buildReport }] = await Promise.all([rpc('admin_report', { p_attempt: attemptId }), import('../../lib/report.js')])
      buildReport(d, { admin: true })
    } catch (e) {
      setErr(e.message)
    }
  }

  const done = (rows || []).filter((r) => r.percentile != null)
  const avgPct = done.length ? done.reduce((a, r) => a + Number(r.percentile), 0) / done.length : null
  const avgAcc = done.length
    ? done.reduce((a, r) => a + (r.correct + r.wrong ? r.correct / (r.correct + r.wrong) : 0), 0) / done.length * 100
    : null
  // oldest to newest, for the trend strip
  const trend = [...done].reverse()
  const best = trend.reduce((m, r) => (m == null || Number(r.percentile) > Number(m.percentile) ? r : m), null)

  return (
    <main className="page">
      <p><Link to="/admin/students">All students</Link></p>
      <div className="spacer" />
      <h1>{rows?.[0]?.name || email}</h1>
      <p className="muted" style={{ marginTop: 10 }}>{email}</p>
      {err && <p className="error" role="alert" style={{ marginTop: 16 }}>{err}</p>}
      {rows === null && !err && <p className="muted" style={{ marginTop: 16 }}>Loading.</p>}
      {rows && rows.length === 0 && <div className="notice plain" style={{ marginTop: 16 }}>No quizzes for this email.</div>}

      {rows && rows.length > 0 && (
        <>
          <div className="spacer" />
          <div className="stats">
            <div><b>{done.length}</b><span className="muted">quizzes submitted</span></div>
            <div><b>{avgPct == null ? '-' : num(Math.round(avgPct * 10) / 10)}</b><span className="muted">average percentile</span></div>
            <div><b>{avgAcc == null ? '-' : `${Math.round(avgAcc)}%`}</b><span className="muted">average accuracy</span></div>
          </div>

          {trend.length > 1 && (
            <section className="block">
              <h2>Percentile over time</h2>
              <p className="muted small" style={{ marginBottom: 12 }}>Oldest on the left, latest in coral. Labels show the latest and the best. Hover a bar for the quiz.</p>
              <div className="trend" role="img" aria-label={`Percentiles oldest to newest: ${trend.map((r) => num(r.percentile)).join(', ')}`}>
                {trend.map((r, i) => (
                  <div key={r.attempt_id} className="trend-col" title={`${r.title}, ${formatWhen(r.submitted_at)}: percentile ${num(r.percentile)}`}>
                    <span className="trend-val">{i === trend.length - 1 || r === best ? Math.round(r.percentile) : ''}</span>
                    <div className="trend-track"><i style={{ height: `${Math.max(2, r.percentile)}%` }} /></div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="block">
            <h2>Quizzes</h2>
            <div className="tablewrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Quiz</th><th>Date</th><th className="n">Score</th><th className="n">Rank</th>
                    <th>Percentile</th><th className="n">Right</th><th className="n">Wrong</th><th className="n">Skipped</th>
                    <th className="n">Time</th><th className="n">Tabs</th><th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.attempt_id}>
                      <td><Link to={`/admin/quiz/${r.quiz_id}/results`}><b>{r.title}</b></Link> <span className="codechip small">{r.code}</span></td>
                      <td className="muted" style={{ whiteSpace: 'nowrap' }}>{formatWhen(r.submitted_at || r.started_at)}</td>
                      {r.status === 'submitted' ? (
                        <>
                          <td className="n" style={{ whiteSpace: 'nowrap' }}><b>{num(r.score)}</b><small className="muted"> / {num(r.total_marks)}</small></td>
                          <td className="n" style={{ whiteSpace: 'nowrap' }}>{r.rank}<small className="muted"> of {r.of}</small></td>
                          <td><div className="bar-cell"><div className="meter"><i style={{ width: `${r.percentile}%` }} /></div><span>{num(r.percentile)}</span></div></td>
                          <td className="n">{r.correct}</td>
                          <td className="n">{r.wrong}</td>
                          <td className="n">{r.unattempted}</td>
                          <td className="n">{spoken(r.time_taken_seconds)}</td>
                        </>
                      ) : (
                        <td colSpan={7} className="muted">In progress</td>
                      )}
                      <td className="n">{r.tab_switches || 0}</td>
                      <td>{r.status === 'submitted' && <button className="link" onClick={() => report(r.attempt_id)}>Report</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  )
}
