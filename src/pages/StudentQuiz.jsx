import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import Brand from '../components/Brand.jsx'
import MathText from '../components/MathText.jsx'
import { rpc, sendQuizCode, toAppError } from '../lib/supabase.js'
import { LETTERS, clock, formatWhen, num, spoken } from '../lib/util.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isAnswered = (v) => v != null && String(v).trim() !== ''
const skey = (code) => `gradquiz:${code}`
const loadSaved = (code) => { try { return JSON.parse(localStorage.getItem(skey(code))) } catch { return null } }
const saveSaved = (code, v) => { try { localStorage.setItem(skey(code), JSON.stringify(v)) } catch { /* private mode */ } }
const dropSaved = (code) => { try { localStorage.removeItem(skey(code)) } catch { /* private mode */ } }
const loadMe = () => { try { return JSON.parse(localStorage.getItem('gradquiz:me')) || {} } catch { return {} } }
const saveMe = (v) => { try { localStorage.setItem('gradquiz:me', JSON.stringify(v)) } catch { /* private mode */ } }

export default function StudentQuiz() {
  const code = (useParams().code || '').toUpperCase()
  const [phase, setPhase] = useState('loading')
  const [info, setInfo] = useState(null)
  const [exam, setExam] = useState(null)
  const [result, setResult] = useState(null)
  const [err, setErr] = useState('')
  const [tick, setTick] = useState(0)
  const [review, setReview] = useState(null)
  const [reviewErr, setReviewErr] = useState('')
  const [notice, setNotice] = useState('')
  const [params, setParams] = useSearchParams()

  useEffect(() => {
    let dead = false
    ;(async () => {
      setPhase('loading')
      // A personal link carries the attempt and its secret. Keep them on this device, then tidy the address bar.
      const a = params.get('a')
      const t = params.get('t')
      let fromLink = false
      if (a || t) {
        fromLink = true
        if (UUID.test(a || '') && UUID.test(t || '')) saveSaved(code, { attemptId: a, token: t })
        else setNotice('That link is not valid. Check that you copied all of it.')
        setParams({}, { replace: true })
      }
      const saved = loadSaved(code)
      if (saved) {
        try {
          const st = await rpc('resume_attempt', { p_attempt: saved.attemptId, p_token: saved.token })
          if (dead) return
          if (st.status === 'in_progress') {
            setExam({ state: st, creds: saved })
            setPhase('exam')
          } else {
            setResult(st)
            setPhase('result')
          }
          return
        } catch (e) {
          if (dead) return
          if (e.code === 'INVALID_ATTEMPT') { dropSaved(code); if (fromLink) setNotice('That link is no longer valid.') }
          else { setErr(e.message); setPhase('error'); return }
        }
      }
      try {
        const i = await rpc('quiz_info', { p_code: code })
        if (dead) return
        setInfo(i)
        setPhase(i?.found ? 'lobby' : 'missing')
      } catch (e) {
        if (!dead) { setErr(e.message); setPhase('error') }
      }
    })()
    return () => { dead = true }
  }, [code, tick])

  function started(st, me) {
    const creds = { attemptId: st.attempt_id, token: st.token, name: me.name, email: me.email }
    saveSaved(code, creds)
    saveMe({ name: me.name, email: me.email })
    setExam({ state: st, creds })
    setPhase('exam')
  }

  function found(res) {
    saveSaved(code, { attemptId: res.attempt_id, token: res.token })
    setNotice('')
    setTick((t) => t + 1)
  }

  async function savePin(pin) {
    const saved = loadSaved(code)
    if (!saved) throw new Error('This device has no saved attempt. Use Find your result with your email and PIN first.')
    setResult(await rpc('set_my_pin', { p_attempt: saved.attemptId, p_token: saved.token, p_pin: pin }))
  }

  async function checkAgain() {
    const saved = loadSaved(code)
    if (!saved) return
    try {
      setResult(await rpc('resume_attempt', { p_attempt: saved.attemptId, p_token: saved.token }))
    } catch { /* keep showing the current result */ }
  }

  async function openReview() {
    const saved = loadSaved(code)
    if (!saved) return
    setReviewErr('')
    try {
      setReview(await rpc('get_review', { p_attempt: saved.attemptId, p_token: saved.token }))
      setPhase('review')
      window.scrollTo(0, 0)
    } catch (e) {
      setReviewErr(e.message)
      checkAgain()
    }
  }

  // Practice: from the result page it uses this device's attempt, from the lobby of an ended open quiz it needs none.
  const [practiceFrom, setPracticeFrom] = useState(null)
  function openPractice(from) {
    setPracticeFrom(from)
    setPhase('practice')
    window.scrollTo(0, 0)
  }

  async function downloadReport() {
    const saved = loadSaved(code)
    if (!saved) throw new Error('This device has no saved attempt. Use Find your result with your email and PIN first.')
    const [d, { buildReport }] = await Promise.all([
      rpc('get_report', { p_attempt: saved.attemptId, p_token: saved.token }),
      import('../lib/report.js'),
    ])
    buildReport(d)
  }

  // The rank and leaderboard move as classmates submit, so refresh them quietly.
  useEffect(() => {
    if (phase !== 'result' || !result?.show_score) return
    const t = setInterval(checkAgain, 30000)
    return () => clearInterval(t)
  }, [phase, result?.show_score]) // eslint-disable-line react-hooks/exhaustive-deps

  if (phase === 'practice') {
    return (
      <Practice
        code={code}
        creds={practiceFrom === 'result' ? loadSaved(code) : null}
        backLabel={practiceFrom === 'result' ? 'Back to your result' : 'Back to the quiz page'}
        onExit={() => { setPhase(practiceFrom === 'result' ? 'result' : 'lobby'); window.scrollTo(0, 0) }}
      />
    )
  }

  if (phase === 'exam') {
    return (
      <Exam
        key={exam.creds.attemptId}
        init={exam.state}
        creds={exam.creds}
        onDone={(res) => { setResult(res); setPhase('result') }}
      />
    )
  }

  return (
    <>
      <header className="bar"><Brand /></header>
      <main className="page narrow">
        {phase === 'loading' && <p className="muted" role="status">Loading your quiz.</p>}
        {phase === 'error' && (
          <div className="stack">
            <h1>Could not load</h1>
            <p className="error" role="alert">{err}</p>
            <button className="btn" onClick={() => setTick((t) => t + 1)}>Try again</button>
          </div>
        )}
        {phase === 'missing' && (
          <div className="stack">
            <h1>Quiz not found</h1>
            <p>The code {code} does not match any quiz. Check it with your instructor.</p>
            <a className="btn" href="/">Enter another code</a>
          </div>
        )}
        {phase === 'lobby' && notice && <div className="notice" role="alert" style={{ marginBottom: 24 }}>{notice}</div>}
        {phase === 'lobby' && <Lobby code={code} info={info} setInfo={setInfo} onStarted={started} onFound={found} onPractice={() => openPractice('lobby')} />}
        {phase === 'result' && <Result res={result} onCheck={checkAgain} onReview={openReview} reviewErr={reviewErr} onSetPin={savePin} onPractice={() => openPractice('result')} onReport={downloadReport} />}
        {phase === 'review' && <Review data={review} onBack={() => setPhase('result')} />}
      </main>
    </>
  )
}

/* ------------------------------------------------------------------ */

function Lobby({ code, info, setInfo, onStarted, onFound, onPractice }) {
  const me = useMemo(loadMe, [])
  const [name, setName] = useState(me.name || '')
  const [email, setEmail] = useState(me.email || '')
  const [pin, setPin] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [finding, setFinding] = useState(false)
  const [fEmail, setFEmail] = useState(me.email || '')
  const [fPin, setFPin] = useState('')
  const [fErr, setFErr] = useState('')
  const [fBusy, setFBusy] = useState(false)
  const invited = info.access === 'invited'
  const [sentTo, setSentTo] = useState('') // the email the code went to
  const [otp, setOtp] = useState('')
  const [sending, setSending] = useState(false)
  const [wait, setWait] = useState(0)
  const [sentNote, setSentNote] = useState('')

  useEffect(() => {
    if (wait <= 0) return
    const t = setTimeout(() => setWait((w) => w - 1), 1000)
    return () => clearTimeout(t)
  }, [wait])

  // Checks name, email and PIN before a code is sent, so nobody gets a code and then hits a form error.
  function formProblem() {
    if (name.trim().replace(/\s+/g, ' ').length < 2) return 'Enter your full name.'
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return 'Enter a valid email address.'
    if (!/^[0-9]{4,6}$/.test(pin.trim())) return 'Choose a PIN with 4 to 6 digits.'
    return ''
  }

  async function sendCode() {
    setErr('')
    setSentNote('')
    const problem = formProblem()
    if (problem) return setErr(problem)
    const to = email.trim().toLowerCase()
    setSending(true)
    try {
      const r = await sendQuizCode(code, to)
      if (r.wait) {
        setWait(r.wait)
        if (sentTo === to) setSentNote(`A code was just sent. You can ask for another in ${r.wait} seconds.`)
        else { setSentTo(to); setSentNote('A code was sent to this email a moment ago. Use that one.') }
      } else {
        setSentTo(to)
        setOtp('')
        setWait(60)
        setSentNote(`Code sent to ${to}. Check spam or promotions if you do not see it.`)
      }
    } catch (ex) {
      setErr(ex.message)
      if (ex.code === 'QUIZ_ENDED' || ex.code === 'QUIZ_NOT_STARTED') {
        try { setInfo(await rpc('quiz_info', { p_code: code })) } catch { /* ignore */ }
      }
    } finally {
      setSending(false)
    }
  }

  async function find(e) {
    e.preventDefault()
    setFBusy(true)
    setFErr('')
    try {
      const res = await rpc('find_my_result', { p_code: code, p_email: fEmail, p_pin: fPin })
      if (res.ok) onFound(res)
      else setFErr(res.locked ? 'Too many wrong tries. Try again in 15 minutes.' : 'That email and PIN do not match. If you forgot your PIN, ask your instructor.')
    } catch (ex) {
      setFErr(ex.message)
    } finally {
      setFBusy(false)
    }
  }

  // A scheduled start counts down on the server clock.
  const skew = useMemo(() => (info.server_now ? new Date(info.server_now).getTime() - Date.now() : 0), [info.server_now])
  const [tickNow, setTickNow] = useState(() => Date.now())
  useEffect(() => {
    if (!info.starts_at || info.status !== 'draft') return
    const t = setInterval(() => setTickNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [info.starts_at, info.status])
  const untilStart = info.starts_at && info.status === 'draft' ? new Date(info.starts_at).getTime() - (tickNow + skew) : null
  const soon = untilStart != null && untilStart < 8000

  // Wait quietly until the quiz starts, checking more often in the last seconds of a countdown.
  useEffect(() => {
    if (info.status !== 'draft') return
    const t = setInterval(async () => {
      try { setInfo(await rpc('quiz_info', { p_code: code })) } catch { /* try again next time */ }
    }, soon ? 2000 : 6000)
    return () => clearInterval(t)
  }, [info.status, code, setInfo, soon])

  async function start(e) {
    e.preventDefault()
    setErr('')
    if (invited && !sentTo) return sendCode()
    if (!/^[0-9]{4,6}$/.test(pin.trim())) return setErr('Choose a PIN with 4 to 6 digits.')
    if (invited && !/^[0-9]{6}$/.test(otp.trim())) return setErr('Type the 6 digit code from your email.')
    setBusy(true)
    try {
      const args = { p_code: code, p_name: name, p_email: invited ? sentTo : email, p_pin: pin.trim() }
      if (invited) args.p_otp = otp.trim()
      const st = await rpc('start_attempt', args)
      if (st?.error) throw toAppError(st.error)
      onStarted(st, { name: name.trim(), email: args.p_email.trim().toLowerCase() })
    } catch (ex) {
      setErr(ex.message)
      if (ex.code === 'QUIZ_ENDED' || ex.code === 'QUIZ_NOT_STARTED') {
        try { setInfo(await rpc('quiz_info', { p_code: code })) } catch { /* ignore */ }
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <h1>{info.title}</h1>
      <ul className="facts">
        <li><b>{info.question_count}</b> questions</li>
        <li><b>{info.duration_minutes}</b> minutes</li>
        <li><b>+{num(info.marks_correct)}</b> for a correct answer</li>
        {info.question_count - info.tita_count > 0 && (
          <li><b>−{num(info.marks_wrong)}</b> for a wrong {info.tita_count > 0 ? 'multiple choice answer' : 'answer'}</li>
        )}
        {info.tita_count > 0 && (
          <li>
            <b>{info.tita_count}</b> type-in {info.tita_count === 1 ? 'question' : 'questions'}
            {Number(info.marks_wrong_tita) > 0
              ? <>, <b>−{num(info.marks_wrong_tita)}</b> for a wrong one</>
              : ', nothing is lost for a wrong one'}
          </li>
        )}
        <li>Unattempted questions score 0</li>
      </ul>
      {info.instructions && <p style={{ whiteSpace: 'pre-wrap' }}>{info.instructions}</p>}

      {info.status === 'draft' && (
        <div className="notice plain waiting" role="status">
          <span className="pulse" aria-hidden="true" />
          <span>
            {untilStart != null
              ? untilStart > 0
                ? <>Starts at {formatWhen(info.starts_at)}, in <b className="tnum">{clock(untilStart / 1000)}</b>. Keep this page open.</>
                : 'Starting now.'
              : 'Waiting for your instructor to start. Keep this page open.'}
          </span>
        </div>
      )}
      {info.status === 'live' && info.ends_at && (
        <div className="notice plain" role="status">
          Entry closes at {formatWhen(info.ends_at)}. Once you start you get the full {info.duration_minutes} minutes.
        </div>
      )}
      {info.status === 'ended' && (
        <div className="stack">
          <div className="notice plain" role="status">This quiz has ended. You can no longer start it.</div>
          {info.practice && (
            <div>
              <button className="btn" onClick={onPractice}>Practise this quiz</button>
              <p className="muted small" style={{ marginTop: 8 }}>Untimed and not scored. You see the answers and explanations when you check.</p>
            </div>
          )}
        </div>
      )}
      {info.status === 'live' && (
        <form className="stack" onSubmit={start} noValidate style={{ marginTop: 32 }}>
          <div className="grid2">
            <label className="field">
              <span>Full name</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
            </label>
            <label className="field">
              <span>Email</span>
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email" required readOnly={Boolean(sentTo)} />
            </label>
          </div>
          <label className="field" style={{ maxWidth: 260 }}>
            <span>PIN</span>
            <input className="input" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="off" maxLength={6} placeholder="4 to 6 digits" required />
            <small>Choose a PIN you will remember. With your email it lets you see your result again later. Do not use a phone number.</small>
          </label>
          {invited && sentTo && (
            <label className="field" style={{ maxWidth: 260 }}>
              <span>Code from your email</span>
              <input className="input codechip" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="6 digits" autoFocus />
            </label>
          )}
          {invited && sentNote && <p className="muted small" role="status">{sentNote}</p>}
          <p className="muted small">
            {invited && !sentTo && 'This quiz is only for invited students. We will email you a code to confirm it is you. '}
            Your timer starts when you press Start. You can attempt this quiz once. If the page closes, reopen this link on the same device to continue.
            {' '}Time spent on each question and switching away from this tab are recorded.
          </p>
          {err && <p className="error" role="alert">{err}</p>}
          <div className="row">
            {invited && !sentTo ? (
              <button className="btn" disabled={sending}>{sending ? 'Sending' : 'Send code to my email'}</button>
            ) : (
              <button className="btn" disabled={busy}>{busy ? 'Starting' : 'Start quiz'}</button>
            )}
            {invited && sentTo && (
              <>
                <button type="button" className="link" onClick={sendCode} disabled={sending || wait > 0}>
                  {sending ? 'Sending' : wait > 0 ? `Resend code in ${wait}s` : 'Resend code'}
                </button>
                <button type="button" className="link" onClick={() => { setSentTo(''); setOtp(''); setSentNote(''); setErr('') }}>Change email</button>
              </>
            )}
          </div>
        </form>
      )}

      {info.status !== 'draft' && (
        <div style={{ marginTop: 40, paddingTop: 24, borderTop: '1px solid var(--rule)' }}>
          {!finding ? (
            <button className="link" onClick={() => setFinding(true)}>Already attempted? Find your result</button>
          ) : (
            <form className="stack" onSubmit={find} noValidate>
              <h3>Find your result</h3>
              <p className="muted small">Use the email and PIN you gave when you started.</p>
              <div className="grid2">
                <label className="field">
                  <span>Email</span>
                  <input className="input" type="email" value={fEmail} onChange={(e) => setFEmail(e.target.value)} autoComplete="email" inputMode="email" />
                </label>
                <label className="field">
                  <span>PIN</span>
                  <input className="input" value={fPin} onChange={(e) => setFPin(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="off" maxLength={6} />
                </label>
              </div>
              {fErr && <p className="error" role="alert">{fErr}</p>}
              <div className="row">
                <button className="btn small" disabled={fBusy}>{fBusy ? 'Looking' : 'Find result'}</button>
                <button type="button" className="link" onClick={() => setFinding(false)}>Cancel</button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function Exam({ init, creds, onDone }) {
  const qs = init.questions
  const [answers, setAnswers] = useState(init.answers || {})
  const [idx, setIdx] = useState(0)
  const [left, setLeft] = useState(() => new Date(init.deadline).getTime() - new Date(init.server_now).getTime())
  const [sync, setSync] = useState('saved')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // CAT style palette state lives on this device only. It never changes the score.
  const uiKey = `gradquiz:ui:${creds.attemptId}`
  const [ui, setUi] = useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem(uiKey)) || {}
      return { visited: new Set(v.visited || []), marked: new Set(v.marked || []) }
    } catch { return { visited: new Set(), marked: new Set() } }
  })

  const answersRef = useRef(answers)
  answersRef.current = answers
  const finished = useRef(false)
  const autoStarted = useRef(false)
  const inflight = useRef(false)
  const again = useRef(false)
  const first = useRef(true)
  const saveTimer = useRef()
  const lost = useRef(false)
  const lastSaved = useRef(JSON.stringify(init.answers || {}))
  const beats = useRef(0)
  const offset = useRef(new Date(init.server_now).getTime() - Date.now())
  const deadline = useMemo(() => new Date(init.deadline).getTime(), [init.deadline])

  // time on each question (ms), counted only while this tab is visible
  const times = useRef(Object.fromEntries(Object.entries(init.times || {}).map(([k, v]) => [k, Number(v) * 1000])))
  const current = useRef(qs[0]?.id)
  const since = useRef(document.visibilityState === 'visible' ? Date.now() : null)
  const tabs = useRef(Number(init.tabs) || 0)
  const away = useRef((Number(init.away) || 0) * 1000)
  const hiddenAt = useRef(null)

  const flushTime = useCallback(() => {
    if (since.current != null && current.current) {
      times.current[current.current] = (times.current[current.current] || 0) + (Date.now() - since.current)
      since.current = Date.now()
    }
  }, [])
  const meta = useCallback(() => {
    flushTime()
    const t = {}
    for (const [k, v] of Object.entries(times.current)) t[k] = Math.round(v / 1000)
    const awayNow = away.current + (hiddenAt.current ? Date.now() - hiddenAt.current : 0)
    return { times: t, tabs: tabs.current, away: Math.round(awayNow / 1000) }
  }, [flushTime])

  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const finish = useCallback((res) => {
    if (finished.current) return
    finished.current = true
    try { localStorage.removeItem(uiKey) } catch { /* ignore */ }
    onDoneRef.current(res)
  }, [uiKey])

  const save = useCallback(async () => {
    if (finished.current || lost.current) return
    if (inflight.current) { again.current = true; return }
    inflight.current = true
    const snap = JSON.stringify(answersRef.current)
    try {
      const res = await rpc('save_answers', { p_attempt: creds.attemptId, p_token: creds.token, p_answers: answersRef.current, p_meta: meta() })
      lastSaved.current = snap
      if (res.status === 'submitted') finish(res)
      else setSync('saved')
    } catch (e) {
      if (e.code === 'INVALID_ATTEMPT') { lost.current = true; setSync('lost') }
      else setSync('offline')
    } finally {
      inflight.current = false
      if (again.current) { again.current = false; save() }
    }
  }, [creds, finish, meta])

  const submit = useCallback(async (auto) => {
    if (finished.current) return
    setBusy(true)
    setErr('')
    try {
      const res = await rpc('submit_attempt', { p_attempt: creds.attemptId, p_token: creds.token, p_answers: answersRef.current, p_meta: meta() })
      finish(res)
    } catch (e) {
      setBusy(false)
      if (e.code === 'INVALID_ATTEMPT') {
        lost.current = true
        setSync('lost')
        setConfirm(false)
        return
      }
      setErr('Could not submit. Check your connection. Trying again shortly.')
      if (auto || e.code === 'NETWORK') setTimeout(() => submit(true), 3000)
    }
  }, [creds, finish, meta])

  const submitRef = useRef(submit)
  submitRef.current = submit

  // countdown, measured against the server clock
  useEffect(() => {
    const t = setInterval(() => {
      const remaining = deadline - (Date.now() + offset.current)
      setLeft(remaining)
      if (remaining <= 0 && !autoStarted.current) {
        autoStarted.current = true
        setConfirm(false)
        submitRef.current(true)
      }
    }, 250)
    return () => clearInterval(t)
  }, [deadline])

  // autosave after every change, plus a slow heartbeat
  useEffect(() => {
    if (first.current) { first.current = false; return }
    setSync('saving')
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(save, 400)
    return () => clearTimeout(saveTimer.current)
  }, [answers, save])

  // Heartbeat. Saves every 12 s when an answer changed, otherwise once a minute. That once-a-minute
  // save also carries the time per question and lets a student submitted by the instructor find out.
  useEffect(() => {
    const t = setInterval(() => {
      beats.current += 1
      if (JSON.stringify(answersRef.current) !== lastSaved.current || beats.current % 5 === 0) save()
    }, 12000)
    return () => clearInterval(t)
  }, [save])

  // leaving the tab: counted, and the question clock pauses
  useEffect(() => {
    const onVis = () => {
      if (finished.current) return
      if (document.visibilityState === 'hidden') {
        flushTime()
        since.current = null
        tabs.current += 1
        hiddenAt.current = Date.now()
      } else {
        if (hiddenAt.current) away.current += Date.now() - hiddenAt.current
        hiddenAt.current = null
        since.current = Date.now()
        save()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [flushTime, save])

  useEffect(() => {
    const warn = (e) => { if (!finished.current) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  const q = qs[idx]
  const order = (x) => (Array.isArray(x.opt_map) && x.opt_map.length === x.options.length ? x.opt_map : x.options.map((_, i) => i))

  // switching question: bank the time on the old one, mark the new one as visited
  useEffect(() => {
    flushTime()
    current.current = q.id
    if (!ui.visited.has(q.id)) setUi((u) => ({ ...u, visited: new Set(u.visited).add(q.id) }))
  }, [q.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    try { localStorage.setItem(uiKey, JSON.stringify({ visited: [...ui.visited], marked: [...ui.marked] })) } catch { /* private mode */ }
  }, [ui, uiKey])

  const choose = (orig) => setAnswers((a) => ({ ...a, [q.id]: orig }))
  const type = (v) => setAnswers((a) => {
    const n = { ...a }
    if (v.trim() === '') delete n[q.id]
    else n[q.id] = v
    return n
  })
  const clear = () => setAnswers((a) => { const n = { ...a }; delete n[q.id]; return n })
  const next = () => setIdx((i) => Math.min(qs.length - 1, i + 1))
  const toggleMark = () => {
    const wasMarked = ui.marked.has(q.id)
    setUi((u) => {
      const m = new Set(u.marked)
      if (wasMarked) m.delete(q.id)
      else m.add(q.id)
      return { ...u, marked: m }
    })
    if (!wasMarked) next()
  }

  const stateOf = (x) => {
    const a = isAnswered(answers[x.id])
    const m = ui.marked.has(x.id)
    if (a && m) return 'am'
    if (m) return 'm'
    if (a) return 'a'
    if (ui.visited.has(x.id)) return 'n'
    return 'v'
  }
  const counts = qs.reduce((c, x) => { c[stateOf(x)] += 1; return c }, { a: 0, n: 0, v: 0, m: 0, am: 0 })
  const answered = counts.a + counts.am
  const STATE_TEXT = { a: 'answered', n: 'not answered', v: 'not visited', m: 'marked for review', am: 'answered and marked for review' }

  useEffect(() => {
    const onKey = (e) => {
      if (confirm || busy || e.metaKey || e.ctrlKey || e.altKey) return
      if (/input|textarea|select/i.test(e.target.tagName)) return
      if (e.key === 'ArrowRight') setIdx((i) => Math.min(qs.length - 1, i + 1))
      else if (e.key === 'ArrowLeft') setIdx((i) => Math.max(0, i - 1))
      else {
        const x = qs[idx]
        const n = LETTERS.indexOf(e.key.toUpperCase())
        if (x.kind === 'mcq' && n >= 0 && n < x.options.length) setAnswers((a) => ({ ...a, [x.id]: order(x)[n] }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirm, busy, idx, qs])

  const syncText = sync === 'lost' ? 'Not saved' : sync === 'offline' ? 'Offline. Retrying.' : sync === 'saving' ? 'Saving' : 'Saved'
  const marked = ui.marked.has(q.id)

  return (
    <>
      <header className="exambar">
        <span className="title">{init.title}</span>
        <div className="row" style={{ gap: 18, flexWrap: 'nowrap' }}>
          <span className={`sync ${sync === 'offline' || sync === 'lost' ? 'off' : ''}`} role="status">{syncText}</span>
          <span className={`timer ${left <= 300000 ? 'low' : ''}`} role="timer" aria-label="Time left">{clock(left / 1000)}</span>
        </div>
      </header>

      <div className="examgrid">
        <main>
          <p className="qmeta">
            Question {idx + 1} of {qs.length}
            {marked && <span className="markflag">Marked for review</span>}
          </p>
          <MathText as="h2" className="qbody" style={{ fontWeight: 400 }} text={q.body} />
          {q.kind === 'tita' ? (
            <div className="typein">
              <label className="sr" htmlFor={`ti-${q.id}`}>Your answer</label>
              <input
                key={q.id}
                id={`ti-${q.id}`}
                className="tita"
                value={answers[q.id] ?? ''}
                onChange={(e) => type(e.target.value)}
                placeholder="Type your answer"
                maxLength={40}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck="false"
              />
              <p className="muted small">Type the answer. For a number, only the digits matter.</p>
            </div>
          ) : (
            <div className="opts" role="radiogroup" aria-label="Answer options">
              {order(q).map((orig, k) => (
                <button
                  key={orig}
                  className="opt"
                  role="radio"
                  aria-checked={answers[q.id] === orig}
                  onClick={() => choose(orig)}
                >
                  <span className="letter">{LETTERS[k]}</span>
                  <MathText className="text" text={q.options[orig]} />
                </button>
              ))}
            </div>
          )}

          <div className="qnav">
            <button className="btn ghost" onClick={() => setIdx(idx - 1)} disabled={idx === 0}>Previous</button>
            <button className="btn ghost markbtn" onClick={toggleMark}>{marked ? 'Unmark' : idx === qs.length - 1 ? 'Mark for review' : 'Mark for review & next'}</button>
            <button className="link" onClick={clear} disabled={!isAnswered(answers[q.id])}>Clear response</button>
            <span style={{ flex: 1 }} />
            {idx < qs.length - 1
              ? <button className="btn" onClick={next}>Save & next</button>
              : <button className="btn dark" onClick={() => setConfirm(true)}>Submit quiz</button>}
          </div>
          {idx < qs.length - 1 && (
            <p style={{ marginTop: 16 }}><button className="link" onClick={() => setConfirm(true)}>Submit quiz</button></p>
          )}
          {err && <p className="error" role="alert" style={{ marginTop: 16 }}>{err}</p>}
          {sync === 'lost' && (
            <p className="error" role="alert" style={{ marginTop: 16 }}>
              This attempt no longer exists, so your answers are not being saved. Ask your instructor.
            </p>
          )}
        </main>

        <aside className="palette-wrap" aria-label="Question list">
          <h3>Questions</h3>
          <div className="palette">
            {qs.map((x, i) => {
              const st = stateOf(x)
              return (
                <button
                  key={x.id}
                  className={`pbtn s-${st} ${i === idx ? 'now' : ''}`}
                  onClick={() => setIdx(i)}
                  aria-label={`Question ${i + 1}, ${STATE_TEXT[st]}`}
                  aria-current={i === idx ? 'true' : undefined}
                >
                  {i + 1}
                </button>
              )
            })}
          </div>
          <ul className="catlegend small">
            <li><i className="pbtn s-a" aria-hidden="true">{counts.a}</i>Answered</li>
            <li><i className="pbtn s-n" aria-hidden="true">{counts.n}</i>Not answered</li>
            <li><i className="pbtn s-v" aria-hidden="true">{counts.v}</i>Not visited</li>
            <li><i className="pbtn s-m" aria-hidden="true">{counts.m}</i>Marked for review</li>
            <li><i className="pbtn s-am" aria-hidden="true">{counts.am}</i>Answered and marked, will be scored</li>
          </ul>
        </aside>
      </div>

      {confirm && (
        <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="sub-h">
          <div className="dialog">
            <h2 id="sub-h">Submit your answers?</h2>
            <p>
              You answered {answered} of {qs.length} questions.
              {qs.length - answered > 0 && ` ${qs.length - answered} will score 0.`}
              {counts.am > 0 && ` ${counts.am} answered and marked for review will be scored.`}
              {' '}You cannot change answers after this.
            </p>
            <div className="row">
              <button className="btn" onClick={() => submit(false)} disabled={busy} autoFocus>{busy ? 'Submitting' : 'Submit now'}</button>
              <button className="btn ghost" onClick={() => setConfirm(false)} disabled={busy}>Keep working</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ */

function Result({ res, onCheck, onReview, reviewErr, onSetPin, onPractice, onReport }) {
  const [repBusy, setRepBusy] = useState(false)
  const [repErr, setRepErr] = useState('')
  async function report() {
    setRepBusy(true)
    setRepErr('')
    try { await onReport() } catch (e) { setRepErr(e.message) } finally { setRepBusy(false) }
  }
  const reason = {
    time: 'Your time ran out, so your answers were submitted automatically.',
    ended: 'Your instructor ended the quiz, so your answers were submitted automatically.',
  }[res.reason]

  return (
    <div className="stack">
      <h1>Submitted</h1>
      <p className="muted">{res.title}</p>
      {reason && <div className="notice plain">{reason}</div>}

      {res.show_score ? (
        <>
          <p className="score" aria-label={`Score ${num(res.score)} out of ${num(res.total_marks)}`}>
            {num(res.score)}<small> / {num(res.total_marks)}</small>
          </p>
          <div className="tally">
            <div><b>{res.correct}</b>correct</div>
            <div><b>{res.wrong}</b>wrong</div>
            <div><b>{res.unattempted}</b>unattempted</div>
            <div><b>{spoken(res.time_taken_seconds)}</b>time taken</div>
          </div>
          {res.rank != null && (
            <div className="rankbox">
              <div><b>{res.rank}<small> of {res.of}</small></b>rank so far</div>
              <div><b>{num(res.percentile)}</b>percentile</div>
              <p className="muted small">Percentile is the share of students who submitted with your score or lower. Both update as more students submit.</p>
            </div>
          )}
          {Array.isArray(res.leaderboard) && res.leaderboard.length > 0 && (
            <div className="lboard">
              <h3>Top {res.leaderboard.length}</h3>
              <ol>
                {res.leaderboard.map((r, i) => (
                  <li key={i} className={r.me ? 'me' : ''}>
                    <span className="rk">{r.rank}</span>
                    <span className="nm">{r.name}{r.me ? ' (you)' : ''}</span>
                    <b>{num(r.score)}</b>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </>
      ) : (
        <div className="stack">
          <p>Your answers are saved. Your instructor will share your score.</p>
          <button className="btn ghost" onClick={onCheck}>Check again</button>
        </div>
      )}

      {res.review_available && (
        <div className="stack" style={{ marginTop: 32 }}>
          <button className="btn" onClick={onReview}>Review answers</button>
        </div>
      )}
      {res.review_on && !res.review_available && (
        <div className="stack" style={{ marginTop: 32 }}>
          <div className="notice plain">Answer review is not open yet. Check again in a bit.</div>
          <div><button className="btn ghost" onClick={onCheck}>Check again</button></div>
        </div>
      )}
      {reviewErr && <p className="error" role="alert">{reviewErr}</p>}

      {(res.show_score || res.practice_available) && (
        <div className="row" style={{ marginTop: 24 }}>
          {res.show_score && <button className="btn ghost" onClick={report} disabled={repBusy}>{repBusy ? 'Making report' : 'Download report (PDF)'}</button>}
          {res.practice_available && <button className="btn ghost" onClick={onPractice}>Practise again, not scored</button>}
        </div>
      )}
      {repErr && <p className="error" role="alert">{repErr}</p>}

      <div className="stack" style={{ marginTop: 40, paddingTop: 28, borderTop: '1px solid var(--rule)' }}>
        <h3>Come back later</h3>
        <p className="muted small">
          {res.has_pin
            ? `To see your result${res.review_on ? ' and answer review' : ''} again on any phone or computer, open this quiz page, choose Find your result, and enter your email and PIN.`
            : 'You have no PIN yet. Set one below so you can find this result again on any phone or computer with your email and PIN.'}
        </p>
        <PinBox hasPin={res.has_pin} onSave={onSetPin} />
      </div>
    </div>
  )
}

function PinBox({ hasPin, onSave }) {
  const [open, setOpen] = useState(false)
  const [pin, setPin] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  async function save(e) {
    e.preventDefault()
    setErr('')
    if (!/^[0-9]{4,6}$/.test(pin)) return setErr('Choose a PIN with 4 to 6 digits.')
    setBusy(true)
    try {
      await onSave(pin)
      setDone(true)
      setOpen(false)
      setPin('')
    } catch (ex) {
      setErr(ex.message)
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <div>
        {done && <p className="okc" role="status" style={{ fontWeight: 700 }}>PIN saved. Use it with your email under Find your result.</p>}
        <button className="link" onClick={() => { setOpen(true); setDone(false) }}>{hasPin || done ? 'Change PIN' : 'Set a PIN'}</button>
      </div>
    )
  }
  return (
    <form className="stack" onSubmit={save} noValidate>
      <label className="field" style={{ maxWidth: 260 }}>
        <span>{hasPin ? 'New PIN' : 'PIN'}</span>
        <input className="input" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="off" maxLength={6} placeholder="4 to 6 digits" autoFocus />
        <small>Choose a PIN you will remember. Do not use a phone number.</small>
      </label>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row">
        <button className="btn small" disabled={busy}>{busy ? 'Saving' : 'Save PIN'}</button>
        <button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  )
}

/* ------------------------------------------------------------------ */

function Review({ data, onBack, heading = 'Review', backLabel = 'Back to result' }) {
  const [filter, setFilter] = useState('all')
  const items = data.items
  const kind = (it) => (it.ok === true ? 'right' : it.ok === false ? 'wrong' : 'skipped')
  const order = (it) => (Array.isArray(it.opt_map) && it.opt_map.length === it.options.length ? it.opt_map : it.options.map((_, i) => i))
  const count = (k) => items.filter((it) => kind(it) === k).length
  const shown = items.map((it, i) => ({ it, i })).filter(({ it }) => filter === 'all' || kind(it) === filter)
  const label = { right: 'Correct', wrong: 'Wrong', skipped: 'Not attempted' }
  const filters = [['all', `All ${items.length}`], ['wrong', `Wrong ${count('wrong')}`], ['skipped', `Not attempted ${count('skipped')}`]]

  return (
    <div>
      {onBack && <p><button className="link" onClick={onBack}>{backLabel}</button></p>}
      <div className="spacer" />
      <h1>{heading}</h1>
      <p className="muted" style={{ marginTop: 10 }}>{data.title}. {count('right')} correct, {count('wrong')} wrong, {count('skipped')} not attempted.</p>
      <div className="kinds" role="radiogroup" aria-label="Show" style={{ marginTop: 24 }}>
        {filters.map(([k, t]) => (
          <button key={k} type="button" role="radio" aria-checked={filter === k} onClick={() => setFilter(k)}>{t}</button>
        ))}
      </div>

      <div style={{ marginTop: 16 }}>
        {shown.length === 0 && <p className="muted" style={{ marginTop: 24 }}>Nothing here.</p>}
        {shown.map(({ it, i }) => (
          <article className="rv" key={it.id}>
            <p className="qmeta">
              Question {i + 1}
              <span className={`verdict ${kind(it)}`}>{it.bonus ? 'Bonus, full marks to everyone' : label[kind(it)]}</span>
            </p>
            <MathText as="h2" className="qbody" style={{ fontWeight: 400 }} text={it.body} />

            {it.kind === 'mcq' ? (
              <ul className="rvopts">
                {order(it).map((orig, k) => {
                  const isRight = orig === it.correct
                  const isYours = orig === it.your
                  return (
                    <li key={orig} className={isRight ? 'is-correct' : isYours ? 'is-wrong' : ''}>
                      <b className="letter">{LETTERS[k]}</b>
                      <MathText className="text" text={it.options[orig]} />
                      <span className="tags">
                        {isYours && <span className={`tag ${isRight ? 'ok' : 'no'}`}>Your answer</span>}
                        {isRight && <span className="tag ok">Correct answer</span>}
                      </span>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <div className="rvtyped">
                <p><span className="k">Your answer </span><b className={it.ok ? 'okc' : it.your == null ? '' : 'noc'}>{it.your == null ? 'Not attempted' : it.your}</b></p>
                <p><span className="k">Correct answer </span><b className="okc">{it.correct.join('  or  ')}</b></p>
              </div>
            )}

            {(it.time != null || it.avg_time != null) && (
              <p className="rvtime muted small">
                {it.time != null && <span>Your time <b>{spoken(it.time)}</b></span>}
                {it.avg_time != null && <span>Class average <b>{spoken(it.avg_time)}</b></span>}
              </p>
            )}

            {it.explanation && (
              <div className="expl"><b>Explanation</b><MathText as="p" text={it.explanation} /></div>
            )}
          </article>
        ))}
      </div>
    </div>
  )
}
/* ------------------------------------------------------------------ */

// Practice run. Nothing is saved on the server, the first attempt's score and rank never change.
function Practice({ code, creds, backLabel, onExit }) {
  const key = `gradquiz:practice:${code}`
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [answers, setAnswers] = useState(() => { try { return JSON.parse(localStorage.getItem(key)) || {} } catch { return {} } })
  const [idx, setIdx] = useState(0)
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [startedAt, setStartedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  const args = useMemo(() => (creds ? { p_attempt: creds.attemptId, p_token: creds.token } : {}), [creds])

  useEffect(() => {
    rpc('practice_questions', { p_code: code, ...args }).then(setData).catch((e) => setErr(e.message))
  }, [code, args])
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(answers)) } catch { /* private mode */ } }, [answers, key])
  useEffect(() => {
    if (result) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [result])

  async function check() {
    const qs = data.questions
    const left = qs.filter((x) => !isAnswered(answers[x.id])).length
    if (left > 0 && !window.confirm(`${left} not answered. Check your answers anyway?`)) return
    setBusy(true)
    setErr('')
    try {
      const r = await rpc('practice_check', { p_code: code, p_answers: answers, ...args })
      setResult({ ...r, seconds: Math.round((Date.now() - startedAt) / 1000) })
      window.scrollTo(0, 0)
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }
  function again() {
    setAnswers({})
    setResult(null)
    setIdx(0)
    setStartedAt(Date.now())
    window.scrollTo(0, 0)
  }

  if (result) {
    return (
      <>
        <header className="bar"><Brand /></header>
        <main className="page narrow">
          <p><button className="link" onClick={onExit}>{backLabel}</button></p>
          <div className="spacer" />
          <p className="qmeta">Practice, not scored</p>
          <h1>{result.title}</h1>
          <p className="score" aria-label={`Practice score ${num(result.score)} out of ${num(result.total_marks)}`}>
            {num(result.score)}<small> / {num(result.total_marks)}</small>
          </p>
          <div className="tally">
            <div><b>{result.correct}</b>correct</div>
            <div><b>{result.wrong}</b>wrong</div>
            <div><b>{result.unattempted}</b>unattempted</div>
            <div><b>{spoken(result.seconds)}</b>time taken</div>
          </div>
          <div className="notice plain" style={{ marginTop: 24 }}>This practice score is not saved. Your first attempt's score and rank stay the same.</div>
          <div className="row" style={{ marginTop: 20 }}>
            <button className="btn" onClick={again}>Practise again</button>
          </div>
          <div className="spacer" />
          <Review data={result} heading="Answers" />
        </main>
      </>
    )
  }

  if (!data) {
    return (
      <>
        <header className="bar"><Brand /></header>
        <main className="page narrow stack">
          {err ? <><p className="error" role="alert">{err}</p><div><button className="btn ghost" onClick={onExit}>{backLabel}</button></div></> : <p className="muted">Loading practice.</p>}
        </main>
      </>
    )
  }

  const qs = data.questions
  const q = qs[idx]
  const set = (v) => setAnswers((a) => {
    const n = { ...a }
    if (v == null || (typeof v === 'string' && v.trim() === '')) delete n[q.id]
    else n[q.id] = v
    return n
  })
  const done = qs.filter((x) => isAnswered(answers[x.id])).length

  return (
    <>
      <header className="exambar">
        <span className="title">Practice · {data.title}</span>
        <div className="row" style={{ gap: 18, flexWrap: 'nowrap' }}>
          <span className="sync">Not scored</span>
          <span className="timer" role="timer" aria-label="Time so far">{clock((now - startedAt) / 1000)}</span>
        </div>
      </header>
      <div className="examgrid">
        <main>
          <p className="qmeta">Question {idx + 1} of {qs.length}</p>
          <MathText as="h2" className="qbody" style={{ fontWeight: 400 }} text={q.body} />
          {q.kind === 'tita' ? (
            <div className="typein">
              <label className="sr" htmlFor={`pt-${q.id}`}>Your answer</label>
              <input key={q.id} id={`pt-${q.id}`} className="tita" value={answers[q.id] ?? ''} onChange={(e) => set(e.target.value)}
                placeholder="Type your answer" maxLength={40} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck="false" />
            </div>
          ) : (
            <div className="opts" role="radiogroup" aria-label="Answer options">
              {q.options.map((o, k) => (
                <button key={k} className="opt" role="radio" aria-checked={answers[q.id] === k} onClick={() => set(k)}>
                  <span className="letter">{LETTERS[k]}</span>
                  <MathText className="text" text={o} />
                </button>
              ))}
            </div>
          )}
          <div className="qnav">
            <button className="btn ghost" onClick={() => setIdx(idx - 1)} disabled={idx === 0}>Previous</button>
            <button className="link" onClick={() => set(null)} disabled={!isAnswered(answers[q.id])}>Clear response</button>
            <span style={{ flex: 1 }} />
            {idx < qs.length - 1
              ? <button className="btn" onClick={() => setIdx(idx + 1)}>Next</button>
              : <button className="btn dark" onClick={check} disabled={busy}>{busy ? 'Checking' : 'Check answers'}</button>}
          </div>
          {idx < qs.length - 1 && <p style={{ marginTop: 16 }}><button className="link" onClick={check} disabled={busy}>Check answers now</button></p>}
          {err && <p className="error" role="alert" style={{ marginTop: 16 }}>{err}</p>}
          <p style={{ marginTop: 28 }}><button className="link" onClick={onExit}>Leave practice</button></p>
        </main>
        <aside className="palette-wrap" aria-label="Question list">
          <h3>Questions</h3>
          <div className="palette">
            {qs.map((x, i) => (
              <button key={x.id} className={`pbtn ${isAnswered(answers[x.id]) ? 's-a' : ''} ${i === idx ? 'now' : ''}`} onClick={() => setIdx(i)}
                aria-label={`Question ${i + 1}, ${isAnswered(answers[x.id]) ? 'answered' : 'not answered'}`} aria-current={i === idx ? 'true' : undefined}>
                {i + 1}
              </button>
            ))}
          </div>
          <p className="muted small" style={{ marginTop: 12 }}>{done} of {qs.length} answered</p>
        </aside>
      </div>
    </>
  )
}
