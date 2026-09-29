import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { check, supabase } from '../../lib/supabase.js'
import { copyText, num } from '../../lib/util.js'
import { useToast } from '../../components/Toast.jsx'

// One LRDI week at a glance: every student against every quiz of the week, in the order they open.
// A student who missed a quiz that has ended cannot go further this week, so they show as stuck.

const RANK = { core: 0, challenge: 1, surprise: 2, sectional: 3 }
const rank = (x) => (RANK[x.day_type] ?? 9) * 10000 + (x.day_no || 0) * 10 + (x.part === 'post' ? 1 : 0)
const DAYS = { core: 'Core', challenge: 'Challenge', surprise: 'Surprise' }
const short = (x) => (x.day_type === 'sectional' ? 'Sectional' : `${DAYS[x.day_type][0]}${x.day_no || 1} ${x.part === 'post' ? 'Quiz' : 'Pre'}`)
const long = (x) => (x.day_type === 'sectional' ? 'Sectional' : `${DAYS[x.day_type]} Day ${x.day_no || 1} ${x.part === 'post' ? 'Quiz' : 'Pre-quiz'}`)

export default function WeekProgress() {
  const [params] = useSearchParams()
  const program = params.get('program') || 'LRDI'
  const batch = params.get('batch') || ''
  const week = Number(params.get('week'))
  const toast = useToast()
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [show, setShow] = useState('all')
  const [q, setQ] = useState('')

  useEffect(() => {
    (async () => {
      try {
        const quizzes = check(await supabase.from('quizzes')
          .select('id, code, title, topic, status, day_type, day_no, part, marks_correct, starts_at, questions(count)')
          .eq('program', program).ilike('batch', batch.replace(/[%_\\]/g, '\\$&')).eq('week_no', week))
          .filter((x) => x.day_type in RANK)
          .sort((a, b) => rank(a) - rank(b))
        const prog = check(await supabase.from('programs').select('roster_only').eq('name', program).maybeSingle())
        const members = prog?.roster_only ? check(await supabase.from('program_members').select('email').eq('program', program)).map((r) => r.email) : []
        const attempts = quizzes.length
          ? check(await supabase.from('attempts').select('quiz_id, name, email, status, score, started_at').in('quiz_id', quizzes.map((x) => x.id)))
          : []
        setData({ quizzes, members, attempts, roster: Boolean(prog?.roster_only) })
      } catch (e) { setErr(e.message) }
    })()
  }, [program, batch, week])

  const rows = useMemo(() => {
    if (!data) return []
    const byEmail = new Map()
    const touch = (email) => {
      const k = email.toLowerCase()
      if (!byEmail.has(k)) byEmail.set(k, { email: k, name: '', cells: {} })
      return byEmail.get(k)
    }
    data.members.forEach(touch)
    for (const a of data.attempts) {
      const r = touch(a.email)
      if (a.name && (!r.nameAt || a.started_at > r.nameAt)) { r.name = a.name; r.nameAt = a.started_at }
      r.cells[a.quiz_id] = a
    }
    const list = [...byEmail.values()].map((r) => {
      // where they are: the first quiz of the week they have not submitted
      const next = data.quizzes.find((x) => r.cells[x.id]?.status !== 'submitted')
      let state = 'done'
      if (next) {
        state = next.status === 'ended' ? 'stuck' : next.status === 'live' ? 'due' : 'waiting'
        if (r.cells[next.id]?.status === 'in_progress') state = 'working'
      }
      const done = data.quizzes.filter((x) => r.cells[x.id]?.status === 'submitted').length
      const total = data.quizzes.reduce((t, x) => t + (r.cells[x.id]?.status === 'submitted' ? Number(r.cells[x.id].score || 0) : 0), 0)
      return { ...r, next, state, done, total }
    })
    // week rank on the total, among students who submitted at least one
    const scored = list.filter((r) => r.done > 0)
    list.forEach((r) => { r.rank = r.done > 0 ? 1 + scored.filter((o) => o.total > r.total).length : null })
    return list
  }, [data])
  const [sort, setSort] = useState('name')
  const sorted = useMemo(() => [...rows].sort((a, b) => (sort === 'total' ? (b.total - a.total) || 0 : 0) || (a.name || a.email).localeCompare(b.name || b.email)), [rows, sort])

  if (err) return <main className="page"><p className="error" role="alert">{err}</p></main>
  if (!data) return <main className="page"><p className="muted">Loading.</p></main>

  const topic = data.quizzes.find((x) => x.topic)?.topic || ''
  const counts = { all: rows.length, stuck: rows.filter((r) => r.state === 'stuck').length, due: rows.filter((r) => r.state === 'due' || r.state === 'working').length, done: rows.filter((r) => r.state === 'done').length }
  const term = q.trim().toLowerCase()
  const shown = sorted.filter((r) => (show === 'all' || (show === 'due' ? ['due', 'working'].includes(r.state) : r.state === show))
    && (!term || r.email.includes(term) || r.name.toLowerCase().includes(term)))
  const total = (x) => (x.questions?.[0]?.count ?? 0) * Number(x.marks_correct)
  const whereText = (r) => (
    r.state === 'done' ? 'All done'
      : r.state === 'stuck' ? `Stuck: missed ${long(r.next)}`
        : r.state === 'working' ? `Working on ${long(r.next)}`
          : r.state === 'due' ? `${long(r.next)} is live`
            : `Up to date, next ${long(r.next)}`)

  return (
    <main className="page wide">
      <p><Link to="/admin">All quizzes</Link></p>
      <div className="spacer" />
      <h1>Week {week}{topic ? ` · ${topic}` : ''}</h1>
      <p className="muted" style={{ marginTop: 10 }}>{program} · {batch} · {data.quizzes.length} quizzes · {rows.length} students{data.roster ? ' on the list' : ' who attempted'}</p>

      {data.quizzes.length === 0 ? (
        <p className="muted" style={{ marginTop: 24 }}>No quizzes in this week yet. <Link to={`/admin/new-week?program=${encodeURIComponent(program)}&batch=${encodeURIComponent(batch)}`}>Make the week</Link>.</p>
      ) : (
        <>
          <div className="row between" style={{ marginTop: 24, alignItems: 'flex-end' }}>
            <div className="kinds" role="radiogroup" aria-label="Show">
              {[['all', 'All'], ['stuck', 'Stuck'], ['due', 'Has one live'], ['done', 'All done']].map(([k, t]) => (
                <button key={k} type="button" role="radio" aria-checked={show === k} onClick={() => setShow(k)}>{t} {counts[k]}</button>
              ))}
            </div>
            <div className="row">
              <input className="input" style={{ width: 220 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search students" aria-label="Search students" />
              <button className="btn ghost small" disabled={shown.length === 0} onClick={async () => { await copyText(shown.map((r) => r.email).join('\n')); toast(`${shown.length} ${shown.length === 1 ? 'email' : 'emails'} copied`) }}>Copy these emails</button>
            </div>
          </div>
          <p className="muted small" style={{ marginTop: 10 }}>
            Each quiz opens only after the one before it is submitted, so a student who missed a quiz that has ended is stuck for the rest of the week.
          </p>

          <div className="progwrap">
            <table className="progtable">
              <thead>
                <tr>
                  <th className="stu">Student</th>
                  <th className="where">Where they are</th>
                  <th><button type="button" className="link" onClick={() => setSort(sort === 'total' ? 'name' : 'total')} title="Sort">Week total {sort === 'total' ? '↓' : ''}</button></th>
                  {data.quizzes.map((x) => (
                    <th key={x.id} title={`${long(x)}: ${x.title}`}>
                      <Link to={`/admin/quiz/${x.id}/results`} className={`daychip d-${x.day_type}`}>{short(x)}</Link>
                      <span className={`pstatus ${x.status}`}>{x.status === 'draft' ? (x.starts_at ? 'Scheduled' : 'Draft') : x.status === 'live' ? 'Live' : 'Ended'}</span>
                      <span className="muted small">{rows.filter((r) => r.cells[x.id]?.status === 'submitted').length}/{rows.length}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.email} className={`p-${r.state}`}>
                    <th className="stu" scope="row">
                      <Link to={`/admin/students/${encodeURIComponent(r.email)}`}><b>{r.name || r.email}</b></Link>
                      {r.name && <span className="muted small">{r.email}</span>}
                    </th>
                    <td className="where">{whereText(r)}</td>
                    <td className="wtotal">{r.rank ? <><b>{num(r.total)}</b><span className="muted small">#{r.rank}{r.rank <= 5 ? ' ★' : ''}</span></> : <span className="muted">·</span>}</td>
                    {data.quizzes.map((x) => {
                      const a = r.cells[x.id]
                      if (a?.status === 'submitted') return <td key={x.id} className="c-done">{a.score != null ? <>{num(a.score)}<span className="muted">/{num(total(x))}</span></> : '✓'}</td>
                      if (a) return <td key={x.id} className="c-working">Working</td>
                      if (x.status === 'ended') return <td key={x.id} className="c-missed">Missed</td>
                      if (x.status === 'live') return <td key={x.id} className={r.next?.id === x.id ? 'c-due' : 'c-locked'}>{r.next?.id === x.id ? 'Due' : '🔒'}</td>
                      return <td key={x.id} className="c-none">·</td>
                    })}
                  </tr>
                ))}
                {shown.length === 0 && <tr><td colSpan={data.quizzes.length + 3} className="muted">Nobody here.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  )
}
