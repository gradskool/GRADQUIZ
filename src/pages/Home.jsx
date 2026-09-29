import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import Brand from '../components/Brand.jsx'
import { rpc } from '../lib/supabase.js'
import { formatWhen, num } from '../lib/util.js'

const PREFIX = 'gradquiz:'

// Every attempt this device is holding, saved by the quiz page as gradquiz:CODE
function readSaved() {
  const out = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith(PREFIX) || k === 'gradquiz:me') continue
      try {
        const v = JSON.parse(localStorage.getItem(k))
        if (v && v.attemptId && v.token) out.push({ key: k, a: v.attemptId, t: v.token })
      } catch { /* skip a broken entry */ }
    }
  } catch { /* private mode */ }
  return out
}

function keep(item) {
  try {
    const key = PREFIX + item.code
    let old = {}
    try { old = JSON.parse(localStorage.getItem(key)) || {} } catch { /* none */ }
    localStorage.setItem(key, JSON.stringify({ ...old, attemptId: item.attempt_id, token: item.token }))
  } catch { /* private mode */ }
}

function meEmail() {
  try { return (JSON.parse(localStorage.getItem('gradquiz:me')) || {}).email || '' } catch { return '' }
}

export default function Home() {
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const nav = useNavigate()

  const [items, setItems] = useState([])
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState(meEmail())
  const [pin, setPin] = useState('')
  const [fErr, setFErr] = useState('')
  const [fBusy, setFBusy] = useState(false)
  const [searched, setSearched] = useState(false)
  const [ask, setAsk] = useState(false)
  const [askCode, setAskCode] = useState('')
  const [askBusy, setAskBusy] = useState(false)
  const [askDone, setAskDone] = useState(false)
  const [askErr, setAskErr] = useState('')
  const box = useRef(null)
  const [progress, setProgress] = useState([])

  // Overall numbers for every attempt this device holds. Only attempts whose secret matches come back.
  const loadProgress = () => {
    const saved = readSaved()
    if (saved.length === 0) return
    rpc('my_progress', { p_items: saved.map((x) => ({ a: x.a, t: x.t })) })
      .then((rows) => setProgress(Array.isArray(rows) ? rows : []))
      .catch(() => { /* the list still works without it */ })
  }

  // results already on this device, no typing needed
  useEffect(() => {
    const saved = readSaved()
    if (saved.length === 0) return
    rpc('my_attempts', { p_items: saved.map((x) => ({ a: x.a, t: x.t })) })
      .then((list) => {
        setItems(list)
        const valid = new Set(list.map((i) => i.attempt_id))
        saved.filter((x) => !valid.has(x.a)).forEach((x) => { try { localStorage.removeItem(x.key) } catch { /* ignore */ } })
      })
      .catch(() => { /* leave the list empty, the form still works */ })
    loadProgress()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function go(e) {
    e.preventDefault()
    const c = code.trim().toUpperCase()
    if (c.length < 4) return setErr('Enter the code your instructor shared.')
    setBusy(true)
    setErr('')
    try {
      const info = await rpc('quiz_info', { p_code: c })
      if (!info?.found) setErr('No quiz matches that code. Check it and try again.')
      else nav(`/q/${c}`)
    } catch (ex) {
      setErr(ex.message)
    } finally {
      setBusy(false)
    }
  }

  function showResults() {
    setOpen(true)
    setTimeout(() => box.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  async function askInstructor(e) {
    e.preventDefault()
    setAskErr('')
    if (askCode.trim().length < 4) return setAskErr('Enter the code of the quiz.')
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setAskErr('Enter the email you used for that quiz.')
    setAskBusy(true)
    try {
      await rpc('request_result_link', { p_code: askCode, p_email: email })
      setAskDone(true)
    } catch (ex) {
      setAskErr(ex.message)
    } finally {
      setAskBusy(false)
    }
  }

  async function findAll(e) {
    e.preventDefault()
    setFErr('')
    if (!/^[0-9]{4,6}$/.test(pin)) return setFErr('Enter the 4 to 6 digit PIN you chose.')
    setFBusy(true)
    try {
      const res = await rpc('find_all_my_results', { p_email: email, p_pin: pin })
      if (!res.ok) {
        setFErr(res.locked ? 'Too many wrong tries. Try again in 15 minutes.' : 'No results match that email and PIN. Use the PIN you chose when you started.')
        return
      }
      res.items.forEach(keep)
      setItems((old) => {
        const map = new Map(old.map((i) => [i.attempt_id, i]))
        res.items.forEach((i) => { const { token, ...rest } = i; map.set(i.attempt_id, rest) })
        return [...map.values()].sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
      })
      setSearched(true)
      setPin('')
      loadProgress()
    } catch (ex) {
      setFErr(ex.message)
    } finally {
      setFBusy(false)
    }
  }

  const pmap = new Map(progress.map((r) => [r.attempt_id, r]))

  return (
    <>
      <header className="bar">
        <Brand />
        <nav><Link to="/library">Your library</Link></nav>
      </header>
      <main className="page">
        <div className="hero">
          <h1>Enter your quiz code.</h1>
          <p className="lede">Your instructor shares it in class. It is 6 letters and numbers.</p>
          <form className="codebox" onSubmit={go} noValidate>
            <label className="sr" htmlFor="code">Quiz code</label>
            <input
              id="code"
              className="codeinput"
              value={code}
              onChange={(e) => { setCode(e.target.value.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)); setErr('') }}
              placeholder="ABC123"
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck="false"
              autoFocus
              aria-describedby={err ? 'code-err' : undefined}
            />
            {err && <p id="code-err" className="error" role="alert" style={{ marginTop: 12 }}>{err}</p>}
            <div className="row" style={{ marginTop: 24 }}>
              <button className="btn" disabled={busy} style={{ marginTop: 0 }}>{busy ? 'Checking' : 'Continue'}</button>
              <button type="button" className="btn ghost" style={{ marginTop: 0 }} onClick={showResults}>Check my results</button>
            </div>
          </form>
        </div>

        {(open || items.length > 0 || progress.length > 0) && (
          <section className="myresults" ref={box} aria-labelledby="my-h">
            <div className="row between" style={{ alignItems: 'baseline' }}>
              <h2 id="my-h">Your results</h2>
              <Link to="/library">Open your library, all quizzes by topic</Link>
            </div>
            {progress.length > 0 && <Progress rows={progress} />}

            {items.length > 0 && (
              <ul className="mylist">
                {items.map((i) => (
                  <li key={i.attempt_id}>
                    <div className="mymain">
                      <b className="mytitle">{i.title}</b>
                      <span className="muted small">
                        {i.status === 'in_progress' ? 'Started ' : 'Submitted '}{formatWhen(i.status === 'in_progress' ? i.started_at : i.submitted_at)}
                      </span>
                    </div>
                    <div className="myscore">
                      {pmap.get(i.attempt_id)?.rank != null && (
                        <span className="muted small myrank">Rank {pmap.get(i.attempt_id).rank} of {pmap.get(i.attempt_id).of} · {num(pmap.get(i.attempt_id).percentile)} pct</span>
                      )}
                      {i.status === 'in_progress'
                        ? <span>In progress</span>
                        : i.score != null
                          ? <span><b>{num(i.score)}</b> <span className="muted">/ {num(i.total_marks)}</span></span>
                          : <span className="muted small">Score not shared yet</span>}
                    </div>
                    <Link className="btn ghost small" to={`/q/${i.code}`}>{i.status === 'in_progress' ? 'Continue' : 'Open'}</Link>
                  </li>
                ))}
              </ul>
            )}
            {items.length === 0 && searched && <p className="muted">Nothing to show yet.</p>}

            {!open ? (
              <p style={{ marginTop: 20 }}>
                <button className="link" onClick={() => setOpen(true)}>Not on this device? Find all my results</button>
              </p>
            ) : (
              <form className="stack findall" onSubmit={findAll} noValidate>
                <h3>Find all my results</h3>
                <p className="muted small">
                  Use the email and PIN you gave when you started a quiz. You will see every quiz you started with that PIN.
                  A quiz started with a different PIN needs its own search.
                </p>
                <div className="grid2">
                  <label className="field">
                    <span>Email</span>
                    <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email" />
                  </label>
                  <label className="field">
                    <span>PIN</span>
                    <input className="input" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="off" maxLength={6} />
                  </label>
                </div>
                {fErr && <p className="error" role="alert">{fErr}</p>}
                <div><button className="btn small" disabled={fBusy}>{fBusy ? 'Looking' : 'Find results'}</button></div>
              </form>
            )}

            {open && (
              <div className="nopin">
                <h3>No PIN, or forgot it?</h3>
                <p className="muted small">
                  Quizzes taken before PINs were added have none. If you took the quiz on this phone or computer, it is listed above.
                  Open it to set a PIN. Otherwise ask your instructor to reset your PIN.
                </p>
                {askDone ? (
                  <div className="notice plain" role="status">
                    Request sent. Your instructor will give you a new PIN. Then use Find all my results with your email and that PIN.
                  </div>
                ) : !ask ? (
                  <button className="btn ghost small" onClick={() => setAsk(true)}>Ask my instructor to reset my PIN</button>
                ) : (
                  <form className="stack" onSubmit={askInstructor} noValidate>
                    <div className="grid2">
                      <label className="field">
                        <span>Code of that quiz</span>
                        <input className="input" value={askCode} onChange={(e) => setAskCode(e.target.value.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12))} autoComplete="off" autoCapitalize="characters" spellCheck="false" />
                      </label>
                      <label className="field">
                        <span>Email you used</span>
                        <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email" />
                      </label>
                    </div>
                    {askErr && <p className="error" role="alert">{askErr}</p>}
                    <div className="row">
                      <button className="btn small" disabled={askBusy}>{askBusy ? 'Sending' : 'Send request'}</button>
                      <button type="button" className="link" onClick={() => setAsk(false)}>Cancel</button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </section>
        )}
      </main>
    </>
  )
}
// Overall picture across every quiz this student has on this device or found with email + PIN.
function Progress({ rows }) {
  const emails = [...new Set(rows.map((r) => r.email))]
  const [email, setEmail] = useState(() => {
    const me = meEmail().toLowerCase()
    return emails.includes(me) ? me : emails[0]
  })
  const mine = rows.filter((r) => r.email === (emails.includes(email) ? email : emails[0]))
  if (mine.length === 0) return null

  const n = mine.length
  const avg = (f) => mine.reduce((a, r) => a + f(r), 0) / n
  const avgPct = avg((r) => Number(r.percentile))
  const avgScorePct = avg((r) => (Number(r.total_marks) ? (100 * Number(r.score)) / Number(r.total_marks) : 0))
  const right = mine.reduce((a, r) => a + Number(r.correct || 0), 0)
  const tried = mine.reduce((a, r) => a + Number(r.correct || 0) + Number(r.wrong || 0), 0)
  const acc = tried ? (100 * right) / tried : null
  const best = mine.reduce((b, r) => (b == null || Number(r.percentile) > Number(b.percentile) ? r : b), null)
  const aboveAvg = mine.filter((r) => Number(r.score) > Number(r.class_avg)).length
  const trend = [...mine].reverse()
  const last = trend[trend.length - 1]
  const prev = trend[trend.length - 2]
  const change = prev ? Number(last.percentile) - Number(prev.percentile) : null

  return (
    <div className="progress">
      <div className="row between" style={{ alignItems: 'baseline' }}>
        <h3>Your progress</h3>
        {emails.length > 1 && (
          <label className="small muted">
            For{' '}
            <select value={email} onChange={(e) => setEmail(e.target.value)}>
              {emails.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </label>
        )}
      </div>
      <div className="stats" style={{ marginTop: 14 }}>
        <div><b>{n}</b><span className="muted">{n === 1 ? 'quiz' : 'quizzes'}</span></div>
        <div><b>{num(Math.round(avgPct * 10) / 10)}</b><span className="muted">average percentile</span></div>
        <div><b>{Math.round(avgScorePct)}%</b><span className="muted">average score</span></div>
        <div><b>{acc == null ? '-' : `${Math.round(acc)}%`}</b><span className="muted">accuracy</span></div>
        <div><b>{best.rank}<small className="muted"> of {best.of}</small></b><span className="muted">best rank</span></div>
      </div>
      <p className="muted small" style={{ marginTop: 10 }}>
        Above the class average in {aboveAvg} of {n}.
        {change != null && ` Your latest percentile is ${change === 0 ? 'the same as' : `${Math.abs(Math.round(change))} points ${change > 0 ? 'higher' : 'lower'} than`} the one before.`}
        {' '}Best: {num(best.percentile)} percentile in {best.title}.
      </p>
      {trend.length > 1 && (
        <>
          <p className="muted small" style={{ marginTop: 16 }}>Percentile, oldest to latest (latest in coral). Hover or tap a bar for the quiz.</p>
          <div className="trend" style={{ height: 140, marginTop: 8 }} role="img" aria-label={`Percentiles oldest to latest: ${trend.map((r) => num(r.percentile)).join(', ')}`}>
            {trend.map((r, i) => (
              <div key={r.attempt_id} className="trend-col" title={`${r.title}, ${formatWhen(r.submitted_at)}: percentile ${num(r.percentile)}, rank ${r.rank} of ${r.of}`}>
                <span className="trend-val">{i === trend.length - 1 || r === best ? Math.round(r.percentile) : ''}</span>
                <div className="trend-track"><i style={{ height: `${Math.max(2, Number(r.percentile))}%` }} /></div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
