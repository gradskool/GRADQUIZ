import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import Brand from '../components/Brand.jsx'
import { rpc } from '../lib/supabase.js'
import { formatWhen, num } from '../lib/util.js'

// Every attempt this device holds (saved by the quiz page, or found with email + PIN on the home page).
function readSaved() {
  const out = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith('gradquiz:') || k === 'gradquiz:me' || k.startsWith('gradquiz:ui:') || k.startsWith('gradquiz:practice:')) continue
      try {
        const v = JSON.parse(localStorage.getItem(k))
        if (v?.attemptId && v?.token) out.push({ a: v.attemptId, t: v.token })
      } catch { /* skip */ }
    }
  } catch { /* private mode */ }
  return out
}

const stateOf = (q) => {
  if (q.mine?.status === 'in_progress') return 'progress'
  if (q.mine?.status === 'submitted') return 'done'
  if (q.status === 'live') return 'live'
  if (q.status === 'draft') return 'soon'
  return 'missed'
}

export default function Library() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [batch, setBatch] = useState(() => { try { return localStorage.getItem('gradquiz:lib:batch') || '' } catch { return '' } })
  const [filter, setFilter] = useState('all')
  const [q, setQ] = useState('')
  const [openTopics, setOpenTopics] = useState(() => new Set())

  useEffect(() => {
    const saved = readSaved()
    if (saved.length === 0) { setData({ emails: [], quizzes: [] }); return }
    rpc('my_library', { p_items: saved }).then(setData).catch((e) => setErr(e.message))
  }, [])

  const batches = useMemo(() => {
    const m = new Map()
    for (const x of data?.quizzes || []) m.set(x.batch.toLowerCase(), x.batch)
    return [...m.values()].sort((a, b) => a.localeCompare(b))
  }, [data])
  const current = batches.find((b) => b.toLowerCase() === batch.toLowerCase()) || batches[0] || ''
  useEffect(() => { try { if (current) localStorage.setItem('gradquiz:lib:batch', current) } catch { /* ignore */ } }, [current])

  const inBatch = useMemo(() => (data?.quizzes || []).filter((x) => x.batch.toLowerCase() === current.toLowerCase()), [data, current])
  const liveNow = inBatch.filter((x) => ['live', 'progress'].includes(stateOf(x)))
  const soon = inBatch.filter((x) => stateOf(x) === 'soon').sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)))

  const shown = inBatch.filter((x) => {
    const s = stateOf(x)
    if (filter === 'done' && s !== 'done') return false
    if (filter === 'missed' && s !== 'missed') return false
    const t = q.trim().toLowerCase()
    return !t || x.title.toLowerCase().includes(t) || x.topic.toLowerCase().includes(t)
  })
  // topics, most recently active first
  const topics = useMemo(() => {
    const m = new Map()
    for (const x of shown) {
      if (!m.has(x.topic)) m.set(x.topic, [])
      m.get(x.topic).push(x)
    }
    return [...m.entries()].map(([name, list]) => ({
      name,
      list,
      done: list.filter((x) => stateOf(x) === 'done').length,
      counted: list.filter((x) => ['done', 'missed'].includes(stateOf(x))).length,
      live: list.filter((x) => ['live', 'progress'].includes(stateOf(x))).length,
      soon: list.filter((x) => stateOf(x) === 'soon').length,
      latest: list.reduce((m2, x) => (String(x.opened_at) > m2 ? String(x.opened_at) : m2), ''),
    })).sort((a, b) => b.latest.localeCompare(a.latest))
  }, [shown])

  const searching = q.trim() !== '' || filter !== 'all'
  const toggle = (name) => setOpenTopics((s) => { const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name); return n })
  const doneAll = inBatch.filter((x) => stateOf(x) === 'done').length
  const missedAll = inBatch.filter((x) => stateOf(x) === 'missed').length

  return (
    <>
      <header className="bar">
        <Brand />
        <nav><Link to="/">Home</Link></nav>
      </header>
      <main className="page">
        <h1>Your library</h1>
        {err && <p className="error" role="alert" style={{ marginTop: 16 }}>{err}</p>}
        {!data && !err && <p className="muted" style={{ marginTop: 16 }}>Loading.</p>}

        {data && data.quizzes.length === 0 && (
          <div className="stack" style={{ marginTop: 24, maxWidth: 620 }}>
            <p>Your library shows every quiz for your batch: what is live now, what is coming up, and your results.</p>
            <p className="muted">
              {data.emails.length === 0
                ? 'First find yourself: on the home page choose Check my results, then Find all my results with your email and PIN. Then come back here.'
                : 'Nothing here yet. Quizzes appear once your instructor adds them to your batch.'}
            </p>
            <div><Link className="btn" to="/">Go to the home page</Link></div>
          </div>
        )}

        {data && data.quizzes.length > 0 && (
          <>
            <p className="muted" style={{ marginTop: 10 }}>{data.emails.join(', ')}</p>

            {batches.length > 1 && (
              <div className="kinds libtabs" role="tablist" aria-label="Batch" style={{ marginTop: 24 }}>
                {batches.map((b) => (
                  <button key={b} type="button" role="tab" aria-selected={b === current} aria-checked={b === current} onClick={() => setBatch(b)}>{b}</button>
                ))}
              </div>
            )}
            {batches.length === 1 && <p className="qmeta" style={{ marginTop: 20 }}>{current}</p>}

            <p className="muted small" style={{ marginTop: 12 }}>
              {doneAll} done{missedAll ? `, ${missedAll} missed` : ''}{liveNow.length ? `, ${liveNow.length} live now` : ''} in this batch.
            </p>

            {liveNow.length > 0 && (
              <section className="libstrip">
                <h2>Live now</h2>
                <ul>
                  {liveNow.map((x) => (
                    <li key={x.code}>
                      <div>
                        <b>{x.title}</b>
                        <span className="muted small">{x.topic} · {x.question_count} questions · {x.duration_minutes} min{x.ends_at ? ` · entry closes ${formatWhen(x.ends_at)}` : ''}</span>
                      </div>
                      <Link className="btn small" to={`/q/${x.code}`}>{stateOf(x) === 'progress' ? 'Continue' : 'Start'}</Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {soon.length > 0 && (
              <section className="libstrip soon">
                <h2>Coming up</h2>
                <ul>
                  {soon.slice(0, 3).map((x) => (
                    <li key={x.code}>
                      <div>
                        <b>{x.title}</b>
                        <span className="muted small">{x.topic} · starts {formatWhen(x.starts_at)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
                {soon.length > 3 && <p className="muted small">and {soon.length - 3} more</p>}
              </section>
            )}

            <section className="block">
              <div className="row between" style={{ alignItems: 'flex-end' }}>
                <h2 style={{ marginBottom: 0 }}>By topic</h2>
                <div className="row">
                  <div className="kinds" role="radiogroup" aria-label="Show">
                    {[['all', 'All'], ['done', 'Done'], ['missed', 'Missed']].map(([k, t]) => (
                      <button key={k} type="button" role="radio" aria-checked={filter === k} onClick={() => setFilter(k)}>{t}</button>
                    ))}
                  </div>
                  <input className="input" style={{ width: 220 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search quizzes" aria-label="Search quizzes" />
                </div>
              </div>

              {topics.length === 0 && <p className="muted" style={{ marginTop: 20 }}>Nothing matches.</p>}
              <div className="topics">
                {topics.map((t) => {
                  const open = searching || openTopics.has(`${current}|${t.name}`)
                  return (
                    <div key={t.name} className={`topic ${open ? 'open' : ''}`}>
                      <button type="button" className="topichead" onClick={() => toggle(`${current}|${t.name}`)} aria-expanded={open}>
                        <span className="tname">{t.name}</span>
                        <span className="muted small">
                          {[
                            t.counted ? `${t.done} of ${t.counted} done` : '',
                            t.live ? `${t.live} live` : '',
                            t.soon ? `${t.soon} coming up` : '',
                          ].filter(Boolean).join(' · ')}
                        </span>
                        <span className="meter" aria-hidden="true" style={t.counted ? undefined : { visibility: 'hidden' }}><i style={{ width: `${t.counted ? (100 * t.done) / t.counted : 0}%` }} /></span>
                        <span className="chev" aria-hidden="true">{open ? '−' : '+'}</span>
                      </button>
                      {open && (
                        <ul className="liblist">
                          {t.list.map((x) => <QuizRow key={x.code} x={x} />)}
                        </ul>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          </>
        )}
      </main>
    </>
  )
}

function QuizRow({ x }) {
  const s = stateOf(x)
  const m = x.mine
  return (
    <li className={`s-${s}`}>
      <div className="lmain">
        <b>{x.title}</b>
        <span className="muted small">
          {s === 'done' && `Submitted ${formatWhen(m.submitted_at)}`}
          {s === 'missed' && `${formatWhen(x.opened_at)} · missed`}
          {s === 'live' && 'Live now'}
          {s === 'progress' && 'In progress'}
          {s === 'soon' && `Starts ${formatWhen(x.starts_at)}`}
        </span>
      </div>
      <div className="lscore">
        {s === 'done' && (m.score != null
          ? <><b>{num(m.score)}</b><span className="muted"> / {num(m.total_marks)}</span>{m.percentile != null && <span className="muted small lpct">{num(m.percentile)} pct · rank {m.rank} of {m.of}</span>}</>
          : <span className="muted small">Score not shared yet</span>)}
      </div>
      <div className="lact">
        {s === 'done' && <Link className="btn ghost small" to={`/q/${x.code}`}>{x.practice ? 'Result & practice' : 'Result'}</Link>}
        {(s === 'live' || s === 'progress') && <Link className="btn small" to={`/q/${x.code}`}>{s === 'progress' ? 'Continue' : 'Start'}</Link>}
        {s === 'missed' && <span className="muted small">Ended</span>}
      </div>
    </li>
  )
}
