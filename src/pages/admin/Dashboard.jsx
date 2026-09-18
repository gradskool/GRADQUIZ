import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { check, supabase } from '../../lib/supabase.js'
import { copyText, formatWhen, makeCode, quizLink } from '../../lib/util.js'
import { useToast } from '../../components/Toast.jsx'

export default function Dashboard() {
  const [quizzes, setQuizzes] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const nav = useNavigate()
  const toast = useToast()

  const load = useCallback(async () => {
    try {
      const data = check(await supabase
        .from('quizzes')
        .select('id, code, title, status, duration_minutes, created_at, questions(count), attempts(count)')
        .order('created_at', { ascending: false }))
      setQuizzes(data)
    } catch (e) {
      setErr(e.message)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function create() {
    setBusy(true)
    setErr('')
    for (let i = 0; i < 5; i++) {
      const { data, error } = await supabase.from('quizzes').insert({ code: makeCode(), title: 'Untitled quiz' }).select('id').single()
      if (!error) { nav(`/admin/quiz/${data.id}`); return }
      if (!/quizzes_code_key|duplicate/i.test(error.message)) { setErr(error.message); break }
    }
    setBusy(false)
  }

  return (
    <main className="page">
      <div className="row between">
        <h1>Quizzes</h1>
        <button className="btn" onClick={create} disabled={busy}>New quiz</button>
      </div>
      {err && <p className="error" role="alert" style={{ marginTop: 16 }}>{err}</p>}

      <div className="spacer" />
      {quizzes === null && !err && <p className="muted">Loading.</p>}
      {quizzes && quizzes.length === 0 && (
        <div className="notice plain">No quizzes yet. Press New quiz to make your first one.</div>
      )}
      {quizzes && quizzes.length > 0 && (
        <div className="tablewrap">
          <table className="t">
            <thead>
              <tr>
                <th>Quiz</th><th>Code</th><th>Status</th>
                <th className="n">Questions</th><th className="n">Attempts</th><th>Created</th><th />
              </tr>
            </thead>
            <tbody>
              {quizzes.map((q) => (
                <tr key={q.id}>
                  <td><Link to={`/admin/quiz/${q.id}`}><b>{q.title}</b></Link></td>
                  <td><span className="codechip">{q.code}</span></td>
                  <td><span className={`status ${q.status}`}><i />{q.status === 'draft' ? 'Draft' : q.status === 'live' ? 'Live' : 'Ended'}</span></td>
                  <td className="n">{q.questions?.[0]?.count ?? 0}</td>
                  <td className="n">{q.attempts?.[0]?.count ?? 0}</td>
                  <td className="muted">{formatWhen(q.created_at)}</td>
                  <td>
                    <div className="row" style={{ gap: 16, flexWrap: 'nowrap' }}>
                      <button className="link" onClick={async () => { await copyText(quizLink(q.code)); toast('Link copied') }}>Copy link</button>
                      <Link to={`/admin/quiz/${q.id}/results`}>Results</Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}
