import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import Brand from '../components/Brand.jsx'
import { rpc } from '../lib/supabase.js'
import { LETTERS, clock, num, spoken } from '../lib/util.js'

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

  useEffect(() => {
    let dead = false
    ;(async () => {
      setPhase('loading')
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
          if (e.code === 'INVALID_ATTEMPT') dropSaved(code)
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

  async function checkAgain() {
    const saved = loadSaved(code)
    if (!saved) return
    try {
      setResult(await rpc('resume_attempt', { p_attempt: saved.attemptId, p_token: saved.token }))
    } catch { /* keep showing the current result */ }
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
        {phase === 'lobby' && <Lobby code={code} info={info} setInfo={setInfo} onStarted={started} />}
        {phase === 'result' && <Result res={result} onCheck={checkAgain} />}
      </main>
    </>
  )
}

/* ------------------------------------------------------------------ */

function Lobby({ code, info, setInfo, onStarted }) {
  const me = useMemo(loadMe, [])
  const [name, setName] = useState(me.name || '')
  const [email, setEmail] = useState(me.email || '')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  // Wait quietly until the instructor presses Start.
  useEffect(() => {
    if (info.status !== 'draft') return
    const t = setInterval(async () => {
      try { setInfo(await rpc('quiz_info', { p_code: code })) } catch { /* try again next time */ }
    }, 6000)
    return () => clearInterval(t)
  }, [info.status, code, setInfo])

  async function start(e) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const st = await rpc('start_attempt', { p_code: code, p_name: name, p_email: email })
      onStarted(st, { name: name.trim(), email: email.trim().toLowerCase() })
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
          <span>Waiting for your instructor to start. Keep this page open.</span>
        </div>
      )}
      {info.status === 'ended' && (
        <div className="notice plain" role="status">This quiz has ended. You can no longer start it.</div>
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
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email" required />
            </label>
          </div>
          <p className="muted small">
            Your timer starts when you press Start. You can attempt this quiz once. If the page closes, reopen this link on the same device to continue.
          </p>
          {err && <p className="error" role="alert">{err}</p>}
          <div><button className="btn" disabled={busy}>{busy ? 'Starting' : 'Start quiz'}</button></div>
        </form>
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

  const answersRef = useRef(answers)
  answersRef.current = answers
  const finished = useRef(false)
  const autoStarted = useRef(false)
  const inflight = useRef(false)
  const again = useRef(false)
  const first = useRef(true)
  const saveTimer = useRef()
  const offset = useRef(new Date(init.server_now).getTime() - Date.now())
  const deadline = useMemo(() => new Date(init.deadline).getTime(), [init.deadline])

  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const finish = useCallback((res) => {
    if (finished.current) return
    finished.current = true
    onDoneRef.current(res)
  }, [])

  const save = useCallback(async () => {
    if (finished.current) return
    if (inflight.current) { again.current = true; return }
    inflight.current = true
    try {
      const res = await rpc('save_answers', { p_attempt: creds.attemptId, p_token: creds.token, p_answers: answersRef.current })
      if (res.status === 'submitted') finish(res)
      else setSync('saved')
    } catch (e) {
      setSync(e.code === 'INVALID_ATTEMPT' ? 'saved' : 'offline')
    } finally {
      inflight.current = false
      if (again.current) { again.current = false; save() }
    }
  }, [creds, finish])

  const submit = useCallback(async (auto) => {
    if (finished.current) return
    setBusy(true)
    setErr('')
    try {
      const res = await rpc('submit_attempt', { p_attempt: creds.attemptId, p_token: creds.token, p_answers: answersRef.current })
      finish(res)
    } catch (e) {
      setBusy(false)
      setErr('Could not submit. Check your connection. Trying again shortly.')
      if (auto || e.code === 'NETWORK') setTimeout(() => submit(true), 3000)
    }
  }, [creds, finish])

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

  useEffect(() => {
    const t = setInterval(save, 12000)
    return () => clearInterval(t)
  }, [save])

  useEffect(() => {
    const warn = (e) => { if (!finished.current) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  const q = qs[idx]
  const choose = (i) => setAnswers((a) => ({ ...a, [q.id]: i }))
  const type = (v) => setAnswers((a) => {
    const n = { ...a }
    if (v.trim() === '') delete n[q.id]
    else n[q.id] = v
    return n
  })
  const clear = () => setAnswers((a) => { const n = { ...a }; delete n[q.id]; return n })
  const answered = qs.filter((x) => isAnswered(answers[x.id])).length

  useEffect(() => {
    const onKey = (e) => {
      if (confirm || busy || e.metaKey || e.ctrlKey || e.altKey) return
      if (/input|textarea|select/i.test(e.target.tagName)) return
      if (e.key === 'ArrowRight') setIdx((i) => Math.min(qs.length - 1, i + 1))
      else if (e.key === 'ArrowLeft') setIdx((i) => Math.max(0, i - 1))
      else {
        const n = LETTERS.indexOf(e.key.toUpperCase())
        if (qs[idx].kind === 'mcq' && n >= 0 && n < qs[idx].options.length) setAnswers((a) => ({ ...a, [qs[idx].id]: n }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirm, busy, idx, qs])

  const syncText = sync === 'offline' ? 'Offline. Retrying.' : sync === 'saving' ? 'Saving' : 'Saved'

  return (
    <>
      <header className="exambar">
        <span className="title">{init.title}</span>
        <div className="row" style={{ gap: 18, flexWrap: 'nowrap' }}>
          <span className={`sync ${sync === 'offline' ? 'off' : ''}`} role="status">{syncText}</span>
          <span className={`timer ${left <= 300000 ? 'low' : ''}`} role="timer" aria-label="Time left">{clock(left / 1000)}</span>
        </div>
      </header>

      <div className="examgrid">
        <main>
          <p className="qmeta">Question {idx + 1} of {qs.length}</p>
          <h2 className="qbody" style={{ fontWeight: 400 }}>{q.body}</h2>
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
              {q.options.map((o, i) => (
                <button
                  key={i}
                  className="opt"
                  role="radio"
                  aria-checked={answers[q.id] === i}
                  onClick={() => choose(i)}
                >
                  <span className="letter">{LETTERS[i]}</span>
                  <span className="text">{o}</span>
                </button>
              ))}
            </div>
          )}

          <div className="qnav">
            <button className="btn ghost" onClick={() => setIdx(idx - 1)} disabled={idx === 0}>Previous</button>
            <button className="btn ghost" onClick={() => setIdx(idx + 1)} disabled={idx === qs.length - 1}>Next</button>
            <button className="link" onClick={clear} disabled={!isAnswered(answers[q.id])}>Clear response</button>
            <span style={{ flex: 1 }} />
            <button className="btn dark" onClick={() => setConfirm(true)}>Submit quiz</button>
          </div>
          {err && <p className="error" role="alert" style={{ marginTop: 16 }}>{err}</p>}
        </main>

        <aside className="palette-wrap" aria-label="Question list">
          <h3>Questions</h3>
          <div className="palette">
            {qs.map((x, i) => (
              <button
                key={x.id}
                className={`pbtn ${isAnswered(answers[x.id]) ? 'done' : ''} ${i === idx ? 'now' : ''}`}
                onClick={() => setIdx(i)}
                aria-label={`Question ${i + 1}, ${isAnswered(answers[x.id]) ? 'answered' : 'not answered'}`}
                aria-current={i === idx ? 'true' : undefined}
              >
                {i + 1}
              </button>
            ))}
          </div>
          <p className="legend muted small">
            <span><b style={{ color: 'var(--ink)' }}>{answered}</b> answered</span>
            <span><b style={{ color: 'var(--ink)' }}>{qs.length - answered}</b> not answered</span>
          </p>
        </aside>
      </div>

      {confirm && (
        <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="sub-h">
          <div className="dialog">
            <h2 id="sub-h">Submit your answers?</h2>
            <p>
              You answered {answered} of {qs.length} questions.
              {qs.length - answered > 0 && ` ${qs.length - answered} will score 0.`} You cannot change answers after this.
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

function Result({ res, onCheck }) {
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
        </>
      ) : (
        <div className="stack">
          <p>Your answers are saved. Your instructor will share your score.</p>
          <button className="btn ghost" onClick={onCheck}>Check again</button>
        </div>
      )}
    </div>
  )
}
