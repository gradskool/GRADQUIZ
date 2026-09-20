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
  const box = useRef(null)

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
  }, [])

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
    } catch (ex) {
      setFErr(ex.message)
    } finally {
      setFBusy(false)
    }
  }

  return (
    <>
      <header className="bar"><Brand /></header>
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

        {(open || items.length > 0) && (
          <section className="myresults" ref={box} aria-labelledby="my-h">
            <h2 id="my-h">Your results</h2>

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
          </section>
        )}
      </main>
    </>
  )
}