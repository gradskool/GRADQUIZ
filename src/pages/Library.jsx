import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
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
  if (q.status === 'live' && q.needs) return 'waiting' // live, but the earlier quiz of the week comes first
  if (q.status === 'live') return 'live'
  if (q.status === 'draft' && !q.starts_at) return 'locked'
  if (q.status === 'draft') return 'soon'
  return 'missed'
}

// LRDI weeks: Week 3 · Games. Core, Challenge and Surprise days each have a Pre-quiz (before the session);
// Core and Challenge also have a Quiz (after the session). One Sectional per week. Extra sectionals sit outside weeks.
const DAY_ORDER = { core: 0, challenge: 1, surprise: 2, sectional: 3, extra: 4 }
const DAY_NAME = { core: 'Core', challenge: 'Challenge', surprise: 'Surprise' }
export const dayLabel = (x) => (
  x.day_type === 'sectional' ? 'Sectional'
    : x.day_type === 'extra' ? `Extra Sectional${x.day_no ? ` ${x.day_no}` : ''}`
      : x.day_type ? `${DAY_NAME[x.day_type]} Day ${x.day_no || 1}` : '')
const partLabel = (x) => (x.day_type === 'sectional' || x.day_type === 'extra' ? 'Sectional' : x.part === 'post' ? 'Quiz' : x.part === 'pre' ? 'Pre-quiz' : '')
const fullLabel = (x) => [dayLabel(x), ['core', 'challenge', 'surprise'].includes(x.day_type) ? partLabel(x) : ''].filter(Boolean).join(' · ')
const secret = (x) => x.day_type === 'surprise' && x.status === 'draft'
const titleOf = (x) => (secret(x) ? 'Surprise' : x.title)
const byDay = (a, b) => (DAY_ORDER[a.day_type] ?? 9) - (DAY_ORDER[b.day_type] ?? 9) || (a.day_no || 0) - (b.day_no || 0)
  || (a.part === 'post' ? 1 : 0) - (b.part === 'post' ? 1 : 0)
const lockedText = (x) => (
  secret(x) ? 'Revealed when it goes live'
    : x.part === 'post' ? 'Unlocks after the session'
      : x.day_type === 'sectional' ? 'Opens after the Surprise day'
        : 'Opens before the session')

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

  // students on more than one program (say FYQ and LRDI) switch between them; everything below is one program
  const everything = data?.quizzes || []
  const progs = [...new Set(everything.map((x) => x.program || 'FYQ'))].sort((a, b) => (a === 'FYQ' ? -1 : b === 'FYQ' ? 1 : a.localeCompare(b)))
  const [prog, setProg] = useState(() => { try { return localStorage.getItem('gradquiz:lib:program') || '' } catch { return '' } })
  const liveProg = progs.find((p) => everything.some((x) => (x.program || 'FYQ') === p && ['live', 'progress'].includes(stateOf(x))))
  const highlightProg = everything.find((x) => x.code === highlight)?.program
  const currentProg = progs.includes(prog) ? prog : highlightProg || liveProg || progs[0] || ''
  const all = everything.filter((x) => (x.program || 'FYQ') === currentProg)
  function pickProg(p) {
    setProg(p)
    setTab(null)
    try { localStorage.setItem('gradquiz:lib:program', p) } catch { /* ignore */ }
    if (params.get('tab') || params.get('q')) setParams({}, { replace: true })
  }
  const liveAll = all
    .filter((x) => ['live', 'progress', 'waiting'].includes(stateOf(x)))
    .sort((a, b) => (stateOf(a) === 'progress' ? -1 : 0) - (stateOf(b) === 'progress' ? -1 : 0) || (stateOf(a) === 'waiting' ? 1 : 0) - (stateOf(b) === 'waiting' ? 1 : 0) || String(b.opened_at).localeCompare(String(a.opened_at)))
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
  }, [data, hasLiveTab, currentProg]) // eslint-disable-line react-hooks/exhaustive-deps
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
    return !t || [titleOf(x), x.topic, x.week_no ? `week ${x.week_no}` : '', fullLabel(x)].some((v) => String(v || '').toLowerCase().includes(t))
  })
  // weeks newest first (days in Core, Challenge, Surprise order), then plain topics most recently active first
  const topics = useMemo(() => {
    const m = new Map()
    for (const x of shown) {
      const key = x.week_no ? `Week ${x.week_no} · ${x.topic}` : x.day_type === 'extra' ? 'Extra sectionals' : x.topic
      if (!m.has(key)) m.set(key, [])
      m.get(key).push(x)
    }
    return [...m.entries()].map(([name, list]) => ({
      name,
      week: list[0].week_no || null,
      extra: !list[0].week_no && list[0].day_type === 'extra',
      locked: list.filter((x) => stateOf(x) === 'locked').length,
      list: list[0].week_no ? [...list].sort(byDay) : list[0].day_type === 'extra' ? [...list].sort((a, b) => (b.day_no || 0) - (a.day_no || 0) || String(b.opened_at).localeCompare(String(a.opened_at))) : list,
      done: list.filter((x) => stateOf(x) === 'done').length,
      counted: list.filter((x) => ['done', 'missed'].includes(stateOf(x))).length,
      live: list.filter((x) => ['live', 'progress', 'waiting'].includes(stateOf(x))).length,
      soon: list.filter((x) => stateOf(x) === 'soon').length,
      latest: list.reduce((m2, x) => (String(x.opened_at) > m2 ? String(x.opened_at) : m2), ''),
    })).sort((a, b) => (b.week || (b.extra ? 0.5 : 0)) - (a.week || (a.extra ? 0.5 : 0)) || b.latest.localeCompare(a.latest))
  }, [shown])
  const hasWeeks = topics.some((t) => t.week)
  // the newest week starts open; anything the student opens or closes is remembered for this visit
  const [overrides, setOverrides] = useState({})

  const searching = q.trim() !== '' || filter !== 'all'
  const isOpen = (key, i, t) => searching || (key in overrides ? overrides[key] : openTopics.has(key) || (t.week && i === 0))
  const toggle = (key, i, t) => setOverrides((o) => ({ ...o, [key]: !isOpen(key, i, t) }))
  const doneAll = inBatch.filter((x) => stateOf(x) === 'done').length
  const missedAll = inBatch.filter((x) => stateOf(x) === 'missed').length
  const liveInBatch = inBatch.filter((x) => ['live', 'progress'].includes(stateOf(x))).length
  const where = (x) => (x.week_no ? `Week ${x.week_no} · ${x.topic}${x.day_type ? ` · ${fullLabel(x)}` : ''}` : x.day_type === 'extra' ? dayLabel(x) : `${short(x.batch)} › ${x.topic}`)

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

            {progs.length > 1 && (
              <div className="progtabs" role="tablist" aria-label="Program">
                {progs.map((p) => (
                  <button key={p} type="button" role="tab" aria-selected={p === currentProg} onClick={() => pickProg(p)}>
                    {p}
                    {everything.some((x) => (x.program || 'FYQ') === p && ['live', 'progress'].includes(stateOf(x))) && <span className="livedot" aria-hidden="true" style={{ marginLeft: 8, marginRight: 0 }} />}
                  </button>
                ))}
              </div>
            )}

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
                <button key={b} type="button" role="tab" className="libtab" aria-selected={tab === 'batch' && !onLive && b === current} onClick={() => pickBatch(b)} title={b}>
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
                            <b>{titleOf(x)}</b>
                            <span className="muted small">
                              {where(x)} · {x.question_count} questions · {x.duration_minutes} min{x.ends_at ? ` · entry closes ${formatWhen(x.ends_at)}` : ''}
                            </span>
                          </div>
                          {stateOf(x) === 'waiting'
                            ? <span className="lockchip" title={`Submit the ${x.needs} first`}><span aria-hidden="true">🔒</span> {x.needs} first</span>
                            : <Link className="btn small" to={`/q/${x.code}`}>{stateOf(x) === 'progress' ? 'Continue' : 'Start'}</Link>}
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
                            <b>{titleOf(x)}</b>
                            <span className="muted small">
                              {secret(x) ? `${where(x)} · revealed when it goes live` : `${where(x)} · ${x.question_count} questions · ${x.duration_minutes} min`}
                            </span>
                          </div>
                          <span className="small soonat">{secret(x) ? 'Soon' : `Starts ${formatWhen(x.starts_at)}`}</span>
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
                <h2 style={{ marginBottom: 0 }}>{hasWeeks ? 'By week' : 'By topic'}</h2>
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
                {topics.map((t, i) => {
                  const key = `${current}|${t.name}`
                  const open = isOpen(key, i, t)
                  return (
                    <div key={t.name} className={`topic ${open ? 'open' : ''}`}>
                      <button type="button" className="topichead" onClick={() => toggle(key, i, t)} aria-expanded={open}>
                        <span className="tname">{t.name}</span>
                        <span className="muted small">
                          {[
                            t.counted ? `${t.done} of ${t.counted} done` : '',
                            t.live ? `${t.live} live` : '',
                            t.soon ? `${t.soon} coming up` : '',
                            t.locked ? `${t.locked} locked` : '',
                          ].filter(Boolean).join(' · ')}
                        </span>
                        <span className="meter" aria-hidden="true" style={t.counted ? undefined : { visibility: 'hidden' }}><i style={{ width: `${t.counted ? (100 * t.done) / t.counted : 0}%` }} /></span>
                        <span className="chev" aria-hidden="true">{open ? '−' : '+'}</span>
                      </button>
                      {open && t.week && (() => {
                        const wb = (data.weeks || []).find((w) => w.program === currentProg && w.batch === current.toLowerCase() && w.week_no === t.week)
                        return wb ? <WeekBoard wb={wb} /> : null
                      })()}
                      {open && (
                        <ul className="liblist">
                          {t.list.map((x, k) => (
                            <Fragment key={x.code}>
                              {t.week && x.day_type && dayLabel(x) !== (t.list[k - 1] ? dayLabel(t.list[k - 1]) : '') && (
                                <li className={`dayhead d-${x.day_type}`} aria-hidden="true">{dayLabel(x)}</li>
                              )}
                              <QuizRow x={x} />
                            </Fragment>
                          ))}
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

// Week standings: the student's total over the week's scored quizzes so far, and the top 5.
function WeekBoard({ wb }) {
  const me = wb.me
  return (
    <div className="weekboard">
      <div className="wbme">
        <span className="muted small">Your week total</span>
        <span><b>{num(me.total)}</b><span className="muted"> / {num(wb.full_marks)} so far</span></span>
        <span className="muted small">Rank {me.rank} of {wb.of} · {num(me.percentile)} percentile</span>
      </div>
      <div>
      <p className="muted small" style={{ marginBottom: 4 }}>Top {wb.top.length} this week</p>
      <ol className="wbtop" aria-label="Top 5 this week">
        {wb.top.map((r, k) => (
          <li key={k} className={r.rank === me.rank && Number(r.total) === Number(me.total) ? 'me' : ''}>
            <span className="rk">{r.rank}</span>
            <span className="nm">{r.name}</span>
            <b>{num(r.total)}</b>
          </li>
        ))}
      </ol>
      </div>
    </div>
  )
}

function QuizRow({ x }) {
  const s = stateOf(x)
  const m = x.mine
  return (
    <li className={`s-${s}`}>
      <div className="lmain">
        {x.day_type && <span className={`daychip d-${x.day_type}`}>{x.week_no ? partLabel(x) : dayLabel(x)}</span>}
        <b>{titleOf(x)}</b>
        <span className="muted small">
          {s === 'done' && `Submitted ${formatWhen(m.submitted_at)}`}
          {s === 'missed' && `${formatWhen(x.opened_at)} · missed`}
          {s === 'live' && 'Live now'}
          {s === 'waiting' && `Live now · opens after you submit the ${x.needs}`}
          {s === 'progress' && 'In progress'}
          {s === 'soon' && `Starts ${formatWhen(x.starts_at)}`}
          {s === 'locked' && lockedText(x)}
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
        {(s === 'locked' || s === 'waiting') && <span className="lockchip"><span aria-hidden="true">🔒</span> Locked</span>}
      </div>
    </li>
  )
}
