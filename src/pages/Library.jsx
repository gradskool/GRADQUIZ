import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
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
  const [params, setParams] = useSearchParams()
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [batch, setBatch] = useState(() => { try { return localStorage.getItem('gradquiz:lib:batch') || '' } catch { return '' } })
  // 'live' or a batch name. Null until the data arrives, then it opens on Live now when anything is live.
  const [tab, setTab] = useState(null)
  const [filter, setFilter] = useState('all')
  const [q, setQ] = useState('')
  const [openTopics, setOpenTopics] = useState(() => new Set())
  const highlight = (params.get('q') || '').toUpperCase()

  const load = useCallback(() => {
    const saved = readSaved()
    if (saved.length === 0) { setData({ emails: [], quizzes: [] }); return }
    rpc('my_library', { p_items: saved }).then((d) => { setData(d); setErr('') }).catch((e) => setErr(e.message))
  }, [])
  useEffect(() => { load() }, [load])
  // quizzes start and end during class, so check again every minute
  useEffect(() => {
    const t = setInterval(load, 60000)
    return () => clearInterval(t)
  }, [load])

  const all = data?.quizzes || []
  const liveAll = all
    .filter((x) => ['live', 'progress'].includes(stateOf(x)))
    .sort((a, b) => (stateOf(a) === 'progress' ? -1 : 0) - (stateOf(b) === 'progress' ? -1 : 0) || String(b.opened_at).localeCompare(String(a.opened_at)))
  const soonAll = all.filter((x) => stateOf(x) === 'soon').sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)))
  const hasLiveTab = liveAll.length > 0 || soonAll.length > 0

  const batches = useMemo(() => {
    const m = new Map()
    for (const x of all) m.set(x.batch.toLowerCase(), x.batch)
    return [...m.values()].sort((a, b) => a.localeCompare(b))
  }, [all])
  // "CAT 2026- Algebra", "CAT 2026- Geometry" share "CAT 2026- ": show it once above the tabs
  const common = useMemo(() => {
    if (batches.length < 2) return ''
    let pre = batches[0]
    for (const b of batches) while (pre && !b.startsWith(pre)) pre = pre.slice(0, -1)
    const cut = pre.search(/[\s\-–—:|/›>]+[^\s\-–—:|/›>]*$/)
    pre = cut >= 0 ? pre.slice(0, pre.length - pre.slice(cut).replace(/^[\s\-–—:|/›>]+/, '').length) : ''
    return batches.every((b) => b.length > pre.length) && /\S/.test(pre) ? pre : ''
  }, [batches])
  const short = (b) => (common ? b.slice(common.length) : b)
  const current = batches.find((b) => b.toLowerCase() === batch.toLowerCase()) || batches[0] || ''

  // pick the opening tab once data is in; fall back to a batch when the Live now tab disappears
  useEffect(() => {
    if (!data) return
    if (tab === null) setTab(hasLiveTab && (params.get('tab') === 'live' || liveAll.length > 0) ? 'live' : 'batch')
    else if (tab === 'live' && !hasLiveTab) setTab('batch')
  }, [data, hasLiveTab]) // eslint-disable-line react-hooks/exhaustive-deps
  const onLive = tab === 'live' && hasLiveTab

  function pickBatch(b) {
    setBatch(b)
    setTab('batch')
    try { localStorage.setItem('gradquiz:lib:batch', b) } catch { /* ignore */ }
    if (params.get('tab') || params.get('q')) setParams({}, { replace: true })
  }
  function pickLive() {
    setTab('live')
  }

  // bring the quiz from the home page banner into view
  useEffect(() => {
    if (!onLive || !highlight) return
    const el = document.getElementById(`live-${highlight}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [onLive, highlight, data])

  const inBatch = useMemo(() => all.filter((x) => x.batch.toLowerCase() === current.toLowerCase()), [all, current])
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
  const liveInBatch = inBatch.filter((x) => ['live', 'progress'].includes(stateOf(x))).length
  const where = (x) => `${short(x.batch)} › ${x.topic}`

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

            {common && <p className="qmeta" style={{ marginTop: 24 }}>{common.replace(/[\s\-–—:|/›>]+$/, '')}</p>}
            <div className="libtabs" role="tablist" aria-label="Library" style={{ marginTop: common ? 8 : 24 }}>
              {hasLiveTab && (
                <button type="button" role="tab" className="libtab livetab" aria-selected={onLive} onClick={pickLive}>
                  {liveAll.length > 0
                    ? <><span className="livedot" aria-hidden="true" />Live now ({liveAll.length})</>
                    : <>Starting soon ({soonAll.length})</>}
                </button>
              )}
              {batches.map((b) => (
                <button key={b} type="button" role="tab" className="libtab" aria-selected={!onLive && b === current} onClick={() => pickBatch(b)} title={b}>
                  {short(b)}
                </button>
              ))}
            </div>

            {onLive ? (
              <>
                {liveAll.length > 0 && (
                  <section className="libstrip">
                    <h2>Live now</h2>
                    <ul>
                      {liveAll.map((x) => (
                        <li key={x.code} id={`live-${x.code}`} className={x.code === highlight ? 'hl' : ''}>
                          <div>
                            <b>{x.title}</b>
                            <span className="muted small">
                              {where(x)} · {x.question_count} questions · {x.duration_minutes} min{x.ends_at ? ` · entry closes ${formatWhen(x.ends_at)}` : ''}
                            </span>
                          </div>
                          <Link className="btn small" to={`/q/${x.code}`}>{stateOf(x) === 'progress' ? 'Continue' : 'Start'}</Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {liveAll.length === 0 && <p className="muted" style={{ marginTop: 24 }}>Nothing is live right now.</p>}
                {soonAll.length > 0 && (
                  <section className="libstrip soon">
                    <h2>Starting soon</h2>
                    <ul>
                      {soonAll.map((x) => (
                        <li key={x.code}>
                          <div>
                            <b>{x.title}</b>
                            <span className="muted small">{where(x)} · {x.question_count} questions · {x.duration_minutes} min</span>
                          </div>
                          <span className="small soonat">Starts {formatWhen(x.starts_at)}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <p className="muted small" style={{ marginTop: 16 }}>This list refreshes every minute.</p>
              </>
            ) : (
              <>
                <p className="muted small" style={{ marginTop: 12 }}>
                  {doneAll} done{missedAll ? `, ${missedAll} missed` : ''}{liveInBatch ? `, ${liveInBatch} live now` : ''} in this batch.
                </p>

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
