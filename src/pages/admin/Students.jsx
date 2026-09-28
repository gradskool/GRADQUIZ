import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { rpc } from '../../lib/supabase.js'
import { formatWhen, num } from '../../lib/util.js'

// Everyone who has ever started a quiz, grouped by email.
export default function Students() {
  const [list, setList] = useState(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')

  useEffect(() => {
    rpc('admin_students').then(setList).catch((e) => setErr(e.message))
  }, [])

  const shown = useMemo(() => {
    if (!list) return []
    const t = q.trim().toLowerCase()
    return t ? list.filter((s) => s.email.includes(t) || (s.name || '').toLowerCase().includes(t)) : list
  }, [list, q])

  return (
    <main className="page">
      <h1>Students</h1>
      <p className="muted" style={{ marginTop: 10 }}>Everyone who has started a quiz, by email. Open a student to see every quiz they took.</p>
      <div className="spacer" />
      {err && <p className="error" role="alert">{err}</p>}
      {list === null && !err && <p className="muted">Loading.</p>}
      {list && list.length === 0 && <div className="notice plain">No attempts yet.</div>}
      {list && list.length > 0 && (
        <>
          <input className="input" style={{ maxWidth: 360 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or email" aria-label="Search students" />
          <p className="muted small" style={{ marginTop: 8 }}>{shown.length} of {list.length}</p>
          <div className="tablewrap" style={{ marginTop: 12 }}>
            <table className="t">
              <thead>
                <tr>
                  <th>Name</th><th>Email</th><th className="n">Quizzes</th>
                  <th>Average percentile</th><th className="n">Best</th><th>Last quiz</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => (
                  <tr key={s.email}>
                    <td><Link to={`/admin/students/${encodeURIComponent(s.email)}`}><b>{s.name}</b></Link></td>
                    <td className="muted">{s.email}</td>
                    <td className="n">{s.submitted}{s.quizzes > s.submitted ? <small className="muted"> +{s.quizzes - s.submitted} open</small> : ''}</td>
                    <td>
                      {s.avg_pct == null ? '-' : (
                        <div className="bar-cell"><div className="meter"><i style={{ width: `${s.avg_pct}%` }} /></div><span>{num(s.avg_pct)}</span></div>
                      )}
                    </td>
                    <td className="n">{s.best_pct == null ? '-' : num(s.best_pct)}</td>
                    <td className="muted">{formatWhen(s.last_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  )
}
