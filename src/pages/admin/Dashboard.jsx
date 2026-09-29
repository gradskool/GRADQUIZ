import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { check, supabase } from '../../lib/supabase.js'
import { copyText, formatWhen, makeCode, quizLink } from '../../lib/util.js'
import { useToast } from '../../components/Toast.jsx'

const NO_BATCH = '\u0000none'
const SEP = /[\s\-–—:|/›>]+/

// "CAT 2026- Algebra", "CAT 2026- Geometry" share "CAT 2026- ": shown once above the tabs
function sharedPrefix(list) {
  if (list.length < 2) return ''
  let pre = list[0]
  for (const b of list) while (pre && !b.startsWith(pre)) pre = pre.slice(0, -1)
  const cut = pre.search(/[\s\-–—:|/›>]+[^\s\-–—:|/›>]*$/)
  pre = cut >= 0 ? pre.slice(0, pre.length - pre.slice(cut).replace(new RegExp(`^${SEP.source}`), '').length) : ''
  return list.every((b) => b.length > pre.length) && /\S/.test(pre) ? pre : ''
}

const statusText = { draft: 'Draft', live: 'Live', ended: 'Ended' }
const DAY_ORDER = { core: 0, challenge: 1, surprise: 2, sectional: 3, extra: 4 }
const DAY_NAME = { core: 'Core', challenge: 'Challenge', surprise: 'Surprise' }
const dayLabel = (x) => (
  x.day_type === 'sectional' ? 'Sectional'
    : x.day_type === 'extra' ? `Extra Sectional${x.day_no ? ` ${x.day_no}` : ''}`
      : x.day_type ? `${DAY_NAME[x.day_type]} Day ${x.day_no || 1} · ${x.part === 'post' ? 'Quiz' : 'Pre-quiz'}` : '')
const readTab = () => { try { return localStorage.getItem('gradquiz:admin:tab') || '' } catch { return '' } }

export default function Dashboard() {
  const [quizzes, setQuizzes] = useState(null)
  const [asks, setAsks] = useState({})
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState(null) // 'now', 'drafts', a batch name, or NO_BATCH
  const [status, setStatus] = useState('all')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(() => new Set())
  const [prog, setProg] = useState(() => { try { return localStorage.getItem('gradquiz:admin:view') || 'FYQ' } catch { return 'FYQ' } })
  const nav = useNavigate()
  const toast = useToast()

  const load = useCallback(async () => {
    try {
      const data = check(await supabase
        .from('quizzes')
        .select('id, code, title, status, access, program, starts_at, ends_at, started_at, batch, topic, week_no, day_type, day_no, part, duration_minutes, created_at, questions(count), attempts(count)')
        .order('created_at', { ascending: false }))
      setQuizzes(data)
      const req = await supabase.from('attempts').select('quiz_id').not('link_requested_at', 'is', null)
      if (!req.error) {
        const m = {}
        req.data.forEach((r) => { m[r.quiz_id] = (m[r.quiz_id] || 0) + 1 })
        setAsks(m)
      }
    } catch (e) {
      setErr(e.message)
    }
  }, [])

  useEffect(() => { load() }, [load])
  // scheduled quizzes start and end on their own, so keep the list current
  useEffect(() => {
    const t = setInterval(load, 60000)
    return () => clearInterval(t)
  }, [load])

  async function create() {
    setBusy(true)
    setErr('')
    for (let i = 0; i < 5; i++) {
      const { data, error } = await supabase.from('quizzes').insert({ code: makeCode(), title: 'Untitled quiz', program: currentProg }).select('id').single()
      if (!error) { nav(`/admin/quiz/${data.id}`); return }
      if (!/quizzes_code_key|duplicate/i.test(error.message)) { setErr(error.message); break }
    }
    setBusy(false)
  }

  const everything = quizzes || []
  const progs = [...new Set(everything.map((x) => x.program || 'FYQ'))].sort((a, b) => (a === 'FYQ' ? -1 : b === 'FYQ' ? 1 : a.localeCompare(b)))
  const currentProg = progs.includes(prog) ? prog : progs[0] || 'FYQ'
  const all = everything.filter((x) => (x.program || 'FYQ') === currentProg)
  function pickProg(p) {
    setProg(p)
    setTab(null)
    setStatus('all')
    try { localStorage.setItem('gradquiz:admin:view', p) } catch { /* ignore */ }
  }
  const live = all.filter((x) => x.status === 'live')
  const upcoming = all.filter((x) => x.status === 'draft' && x.starts_at).sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)))
  const drafts = all.filter((x) => x.status === 'draft' && !x.starts_at)
  const unbatched = all.filter((x) => !x.batch)

  const batches = useMemo(() => {
    const m = new Map()
    for (const x of all) if (x.batch) m.set(x.batch.toLowerCase(), x.batch)
    return [...m.values()].sort((a, b) => a.localeCompare(b))
  }, [all])
  const common = useMemo(() => sharedPrefix(batches), [batches])
  const short = (b) => (common ? b.slice(common.length) : b)

  const tabs = [
    ...(live.length || upcoming.length ? ['now'] : []),
    ...(drafts.length ? ['drafts'] : []),
    ...batches,
    ...(unbatched.length ? [NO_BATCH] : []),
  ]
  // open on Live & upcoming when something is running, otherwise where you were last
  useEffect(() => {
    if (!quizzes) return
    if (tab === null || !tabs.includes(tab)) {
      const saved = readTab()
      setTab(tabs.includes('now') && tab === null ? 'now' : tabs.includes(saved) ? saved : tabs.find((t) => t !== 'now' && t !== 'drafts') || tabs[0] || 'all')
    }
  }, [quizzes, tabs.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps
  function pick(t) {
    setTab(t)
    setStatus('all')
    try { if (t !== 'now' && t !== 'drafts') localStorage.setItem('gradquiz:admin:tab', t) } catch { /* ignore */ }
  }

  const search = q.trim().toLowerCase()
  const matches = search
    ? everything.filter((x) => [x.title, x.code, x.batch, x.topic, x.program].some((v) => String(v || '').toLowerCase().includes(search)))
    : []

  const inTab = tab === NO_BATCH ? unbatched : all.filter((x) => x.batch && x.batch.toLowerCase() === String(tab).toLowerCase())
  const filtered = inTab.filter((x) => status === 'all' || x.status === status)
  const topics = useMemo(() => {
    const m = new Map()
    for (const x of filtered) {
      const k = x.week_no ? `Week ${x.week_no} · ${x.topic || ''}` : x.day_type === 'extra' ? 'Extra sectionals' : x.topic || 'No topic'
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(x)
    }
    return [...m.entries()].map(([name, list]) => ({
      name,
      week: list[0].week_no || 0,
      list: list[0].week_no || list[0].day_type === 'extra'
        ? [...list].sort((a, b) => (DAY_ORDER[a.day_type] ?? 9) - (DAY_ORDER[b.day_type] ?? 9) || (a.day_no || 0) - (b.day_no || 0) || (a.part === 'post' ? 1 : 0) - (b.part === 'post' ? 1 : 0))
        : list,
      live: list.filter((x) => x.status === 'live').length,
      draft: list.filter((x) => x.status === 'draft').length,
      attempts: list.reduce((a, x) => a + (x.attempts?.[0]?.count ?? 0), 0),
      latest: list.reduce((m2, x) => (String(x.created_at) > m2 ? String(x.created_at) : m2), ''),
    })).sort((a, b) => b.week - a.week || b.latest.localeCompare(a.latest))
  }, [filtered])
  const toggle = (k) => setOpen((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n })
  const count = (s) => inTab.filter((x) => s === 'all' || x.status === s).length

  // inside a batch tab the batch and topic are already on screen, elsewhere they are shown on each row
  const row = (x, plain) => (
    <QuizRow key={x.id} x={x} asks={asks[x.id]} where={plain ? '' : [search && progs.length > 1 ? x.program : '', x.batch ? `${short(x.batch)}${x.topic ? ` › ${x.topic}` : ''}` : ''].filter(Boolean).join(' · ')}
      onCopy={async () => { await copyText(quizLink(x.code)); toast('Link copied') }} />
  )

  return (
    <main className="page">
      <div className="row between">
        <h1>Quizzes</h1>
        <div className="row">
          <Link className="btn ghost" to={`/admin/new-week?program=${encodeURIComponent(currentProg)}${tab && tab !== 'now' && tab !== 'drafts' && tab !== NO_BATCH ? `&batch=${encodeURIComponent(tab)}` : ''}`}>New week</Link>
          <button className="btn" onClick={create} disabled={busy}>New quiz</button>
        </div>
      </div>
      {err && <p className="error" role="alert" style={{ marginTop: 16 }}>{err}</p>}

      <div className="spacer" />
      {quizzes === null && !err && <p className="muted">Loading.</p>}
      {quizzes && quizzes.length === 0 && (
        <div className="notice plain">No quizzes yet. Press New quiz to make your first one.</div>
      )}

      {quizzes && quizzes.length > 0 && (
        <>
          <div className="row between" style={{ alignItems: 'flex-end' }}>
            <p className="muted small">
              {progs.length > 1 && <b>{currentProg}: </b>}{all.length} quizzes · {live.length} live · {upcoming.length} scheduled · {all.filter((x) => x.status === 'draft').length} drafts
            </p>
            <input className="input" style={{ width: 280 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, code, batch, topic" aria-label="Search quizzes" />
          </div>

          {progs.length > 1 && !search && (
            <div className="progtabs" role="tablist" aria-label="Program">
              {progs.map((p) => (
                <button key={p} type="button" role="tab" aria-selected={p === currentProg} onClick={() => pickProg(p)}>
                  {p} <span>{everything.filter((x) => (x.program || 'FYQ') === p).length}</span>
                  {everything.some((x) => (x.program || 'FYQ') === p && x.status === 'live') && <span className="livedot" aria-hidden="true" style={{ marginLeft: 8, marginRight: 0 }} />}
                </button>
              ))}
            </div>
          )}
          {search ? (
            <section style={{ marginTop: 20 }}>
              <p className="qmeta">{matches.length} {matches.length === 1 ? 'match' : 'matches'} across all programs</p>
              <ul className="alist">{matches.map((x) => row(x))}</ul>
            </section>
          ) : (
            <>
              {common && <p className="qmeta" style={{ marginTop: 20 }}>{common.replace(/[\s\-–—:|/›>]+$/, '')}</p>}
              <div className="libtabs" role="tablist" aria-label="Quiz groups" style={{ marginTop: common ? 8 : 20 }}>
                {tabs.map((t) => (
                  <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => pick(t)}
                    className={`libtab ${t === 'now' ? 'livetab' : ''}`} title={t === 'now' || t === 'drafts' || t === NO_BATCH ? undefined : t}>
                    {t === 'now'
                      ? <>{live.length > 0 && <span className="livedot" aria-hidden="true" />}Live & upcoming ({live.length + upcoming.length})</>
                      : t === 'drafts' ? `Drafts (${drafts.length})`
                        : t === NO_BATCH ? (batches.length ? `No batch (${unbatched.length})` : `All quizzes (${unbatched.length})`)
                          : short(t)}
                  </button>
                ))}
              </div>

              {tab === 'now' && (
                <>
                  <section className="libstrip">
                    <h2>Live now</h2>
                    {live.length === 0 ? <p className="muted small" style={{ marginTop: 8 }}>Nothing live.</p> : <ul className="alist">{live.map((x) => row(x))}</ul>}
                  </section>
                  {upcoming.length > 0 && (
                    <section className="libstrip soon">
                      <h2>Scheduled</h2>
                      <ul className="alist">{upcoming.map((x) => row(x))}</ul>
                    </section>
                  )}
                </>
              )}

              {tab === 'drafts' && (
                <section style={{ marginTop: 24 }}>
                  <p className="muted small">Drafts without a scheduled start. Scheduled drafts are under Live & upcoming.</p>
                  <ul className="alist">{drafts.map((x) => row(x))}</ul>
                </section>
              )}

              {tab !== 'now' && tab !== 'drafts' && tab !== null && (
                <section style={{ marginTop: 24 }}>
                  <div className="kinds" role="radiogroup" aria-label="Status">
                    {['all', 'live', 'draft', 'ended'].map((s) => (
                      <button key={s} type="button" role="radio" aria-checked={status === s} onClick={() => setStatus(s)}>
                        {s === 'all' ? 'All' : statusText[s]} {count(s)}
                      </button>
                    ))}
                  </div>
                  {topics.length === 0 && <p className="muted" style={{ marginTop: 20 }}>Nothing here.</p>}
                  <div className="topics">
                    {topics.map((t) => {
                      const key = `${tab}|${t.name}`
                      const isOpen = status !== 'all' || open.has(key) || topics.length === 1
                      return (
                        <div key={key} className="topic">
                          <button type="button" className="topichead" onClick={() => toggle(key)} aria-expanded={isOpen}>
                            <span className="tname">{t.name}</span>
                            <span className="muted small">
                              {[`${t.list.length} ${t.list.length === 1 ? 'quiz' : 'quizzes'}`, t.live ? `${t.live} live` : '', t.draft ? `${t.draft} draft` : '', `${t.attempts} ${t.attempts === 1 ? 'attempt' : 'attempts'}`].filter(Boolean).join(' · ')}
                            </span>
                            <span />
                            <span className="chev" aria-hidden="true">{isOpen ? '−' : '+'}</span>
                          </button>
                          {isOpen && t.week > 0 && (
                            <p className="weeklinks">
                              <Link to={`/admin/progress?program=${encodeURIComponent(currentProg)}&batch=${encodeURIComponent(tab)}&week=${t.week}`}>Week progress</Link>
                              <Link to={`/admin/new-week?program=${encodeURIComponent(currentProg)}&batch=${encodeURIComponent(tab)}`}>Add days to a week</Link>
                            </p>
                          )}
                          {isOpen && <ul className="alist">{t.list.map((x) => row(x, true))}</ul>}
                        </div>
                      )
                    })}
                  </div>
                </section>
              )}
            </>
          )}
        </>
      )}
    </main>
  )
}

function QuizRow({ x, asks, where, onCopy }) {
  const qn = x.questions?.[0]?.count ?? 0
  const an = x.attempts?.[0]?.count ?? 0
  return (
    <li>
      <div className="amain">
        {x.day_type && <span className={`daychip d-${x.day_type}`}>{x.week_no ? `Week ${x.week_no} · ` : ''}{dayLabel(x)}</span>}
        <Link to={`/admin/quiz/${x.id}`}><b>{x.title}</b></Link>
        <span className="muted small">
          {where && <>{where} · </>}
          <span className="codechip small">{x.code}</span>
          {' · '}{qn} {qn === 1 ? 'question' : 'questions'} · {an} {an === 1 ? 'attempt' : 'attempts'}
        </span>
        <span className="achips">
          {x.access === 'invited' && <span className="chip" style={{ marginLeft: 0 }}>Invited only</span>}
          {x.status === 'draft' && x.starts_at && <span className="chip" style={{ marginLeft: 0 }}>Starts {formatWhen(x.starts_at)}</span>}
          {x.status === 'live' && x.ends_at && <span className="chip" style={{ marginLeft: 0 }}>Entry closes {formatWhen(x.ends_at)}</span>}
          {asks > 0 && <Link to={`/admin/quiz/${x.id}/results`} className="chip" style={{ marginLeft: 0 }}>{asks} asked for help</Link>}
        </span>
      </div>
      <span className={`status ${x.status}`}><i />{statusText[x.status]}</span>
      <span className="muted small adate">{formatWhen(x.started_at || x.created_at)}</span>
      <span className="aact">
        <button className="link" onClick={onCopy}>Copy link</button>
        <Link to={`/admin/quiz/${x.id}/results`}>Results</Link>
      </span>
    </li>
  )
}
