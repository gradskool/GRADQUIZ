import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { check, supabase } from '../../lib/supabase.js'
import { makeCode } from '../../lib/util.js'

// Makes a whole LRDI week in one go, as drafts: a Pre-quiz for every Core, Challenge and Surprise day,
// a Quiz for every Core and Challenge day, and the weekly Sectional. Pre-quizzes start at 10 am and
// quizzes at 6 pm on the dates you give; the Sectional time is yours to set. Questions are added after.

const PRE = '10:00'
const POST = '18:00'
const KINDS = [['core', 'Core'], ['challenge', 'Challenge'], ['surprise', 'Surprise']]
const slotKey = (d, n, p) => `${d}|${n || 0}|${p || ''}`
const pad = (n) => String(n).padStart(2, '0')
const addDays = (iso, k) => {
  if (!iso) return ''
  const d = new Date(`${iso}T12:00`)
  d.setDate(d.getDate() + k)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const when = (date, time) => (date && time ? new Date(`${date}T${time}`).toISOString() : null)
const niceDate = (iso) => (iso ? new Date(`${iso}T12:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) : '')

export default function NewWeek() {
  const [params] = useSearchParams()
  const [programs, setPrograms] = useState([])
  const [existing, setExisting] = useState([])
  const [f, setF] = useState({
    program: params.get('program') || 'LRDI',
    batch: params.get('batch') || '',
    week: '',
    topic: '',
    core: 1,
    challenge: 1,
    surprise: 1,
    sectional: true,
    preMin: '10',
    postMin: '20',
    secMin: '40',
  })
  const [dates, setDates] = useState({}) // day key -> yyyy-mm-dd
  const [times, setTimes] = useState({}) // slot key -> hh:mm
  const [first, setFirst] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState(null)

  useEffect(() => {
    supabase.from('programs').select('name').order('name').then(({ data }) => setPrograms(data || []))
    supabase.from('quizzes').select('id, program, batch, topic, week_no, day_type, day_no, part, title').then(({ data }) => setExisting(data || []))
  }, [])

  const batches = useMemo(() => [...new Set(existing.filter((x) => x.program === f.program && x.batch).map((x) => x.batch))].sort(), [existing, f.program])
  const same = (x) => x.program === f.program && (x.batch || '').toLowerCase() === f.batch.trim().toLowerCase()
  const nextWeek = useMemo(() => existing.filter(same).reduce((m, x) => Math.max(m, x.week_no || 0), 0) + 1, [existing, f.program, f.batch]) // eslint-disable-line react-hooks/exhaustive-deps
  const week = Number(f.week || nextWeek)
  // a week already started keeps its topic, and its existing days are skipped
  const inWeek = existing.filter((x) => same(x) && x.week_no === week)
  useEffect(() => {
    const t = inWeek.find((x) => x.topic)?.topic
    if (t && !f.topic) setF((o) => ({ ...o, topic: t }))
  }, [week, f.batch, existing.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const taken = new Set(inWeek.map((x) => slotKey(x.day_type, x.day_type === 'sectional' ? 0 : x.day_no, x.day_type === 'sectional' ? '' : x.part)))

  // the days of the week in order, each with its quizzes
  const days = []
  for (const [k, name] of KINDS) {
    for (let n = 1; n <= Number(f[k]); n++) {
      days.push({ key: `${k}${n}`, type: k, no: n, label: `${name} Day ${n}`, parts: k === 'surprise' ? ['pre'] : ['pre', 'post'] })
    }
  }
  if (f.sectional) days.push({ key: 'sectional', type: 'sectional', no: 0, label: 'Sectional', parts: [''] })

  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })
  const timeOf = (d, p) => times[slotKey(d.type, d.no, p)] ?? (p === 'pre' ? PRE : p === 'post' ? POST : '')
  function fill() {
    const n = {}
    days.forEach((d, i) => { n[d.key] = addDays(first, i) })
    setDates(n)
  }

  const topic = f.topic.trim().replace(/\s+/g, ' ')
  const titleOf = (d, p) => (d.type === 'sectional' ? `Week ${week} Sectional · ${topic}` : `${topic} · ${d.label} ${p === 'post' ? 'Quiz' : 'Pre-quiz'}`)
  const plan = days.flatMap((d) => d.parts.map((p) => ({
    d, p,
    skip: taken.has(slotKey(d.type, d.no, p)),
    title: titleOf(d, p),
    date: dates[d.key] || '',
    time: timeOf(d, p),
  })))
  const toMake = plan.filter((x) => !x.skip)

  async function create(e) {
    e.preventDefault()
    setErr('')
    if (!f.batch.trim()) return setErr('Give the batch, like LRDI 2026.')
    if (!topic) return setErr('Give the week its topic, like Games & Tournaments.')
    if (!(Number.isInteger(week) && week >= 1 && week <= 500)) return setErr('Week number must be a whole number from 1 to 500.')
    if (toMake.length === 0) return setErr('Everything in this plan already exists in that week.')
    const mins = [f.preMin, f.postMin, f.secMin].map(Number)
    if (mins.some((m) => !Number.isInteger(m) || m < 1 || m > 600)) return setErr('Times must be whole minutes from 1 to 600.')
    const bad = toMake.find((x) => x.date && !x.time)
    if (bad) return setErr(`Give a time for ${bad.d.label}${bad.p ? ` ${bad.p === 'post' ? 'Quiz' : 'Pre-quiz'}` : ''}, or clear its date.`)
    setBusy(true)
    const out = []
    try {
      for (const x of toMake) {
        const row = {
          title: x.title.slice(0, 120),
          program: f.program,
          batch: f.batch.trim().replace(/\s+/g, ' ').slice(0, 60),
          topic: topic.slice(0, 60),
          in_library: true,
          week_no: week,
          day_type: x.d.type,
          day_no: x.d.type === 'sectional' ? null : x.d.no,
          part: x.d.type === 'sectional' ? null : x.p,
          duration_minutes: x.d.type === 'sectional' ? mins[2] : x.p === 'post' ? mins[1] : mins[0],
          starts_at: when(x.date, x.time),
        }
        let done = null
        for (let i = 0; i < 5 && !done; i++) {
          const { data, error } = await supabase.from('quizzes').insert({ ...row, code: makeCode() }).select('id, code, title, starts_at').single()
          if (!error) done = data
          else if (!/quizzes_code_key|duplicate/i.test(error.message)) throw error
        }
        if (done) out.push(done)
      }
      setMade(out)
    } catch (ex) {
      setErr(`${ex.message}${out.length ? ` (${out.length} were made before this.)` : ''}`)
      if (out.length) setMade(out)
    } finally {
      setBusy(false)
    }
  }

  if (made) {
    return (
      <main className="page">
        <p><Link to="/admin">All quizzes</Link></p>
        <div className="spacer" />
        <h1>Week {week} made</h1>
        <p className="muted" style={{ marginTop: 10 }}>{made.length} draft {made.length === 1 ? 'quiz' : 'quizzes'} in {f.batch.trim()} · {topic}. Open each one to add its questions.</p>
        {err && <p className="error" role="alert" style={{ marginTop: 16 }}>{err}</p>}
        <ul className="alist" style={{ marginTop: 20 }}>
          {made.map((x) => (
            <li key={x.id}>
              <div className="amain">
                <Link to={`/admin/quiz/${x.id}`}><b>{x.title}</b></Link>
                <span className="muted small"><span className="codechip small">{x.code}</span> · {x.starts_at ? `starts ${new Date(x.starts_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : 'no start time yet'}</span>
              </div>
              <span />
              <span />
              <span className="aact"><Link to={`/admin/quiz/${x.id}`}>Add questions</Link></span>
            </li>
          ))}
        </ul>
        <div className="row" style={{ marginTop: 24 }}>
          <Link className="btn ghost" to={`/admin/progress?program=${encodeURIComponent(f.program)}&batch=${encodeURIComponent(f.batch.trim())}&week=${week}`}>Week progress</Link>
          <Link className="btn ghost" to="/admin">Back to quizzes</Link>
        </div>
      </main>
    )
  }

  return (
    <main className="page">
      <p><Link to="/admin">All quizzes</Link></p>
      <div className="spacer" />
      <h1>New week</h1>
      <p className="muted" style={{ marginTop: 10, maxWidth: 720 }}>
        Makes every quiz of the week as a draft. Pre-quizzes start at 10:00 am and quizzes at 6:00 pm on the dates you give. You can change any time here or later. Questions are added after.
      </p>
      <form className="stack" onSubmit={create} noValidate style={{ marginTop: 24 }}>
        <div className="grid3">
          <label className="field">
            <span>Program</span>
            <select className="input" value={f.program} onChange={set('program')}>
              {(programs.length ? programs : [{ name: f.program }]).map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Batch</span>
            <input className="input" list="nw-batches" value={f.batch} onChange={set('batch')} placeholder="LRDI 2026" maxLength={60} />
            <datalist id="nw-batches">{batches.map((b) => <option key={b} value={b} />)}</datalist>
          </label>
          <label className="field">
            <span>Week number</span>
            <input className="input" type="number" min="1" max="500" value={f.week} onChange={set('week')} placeholder={String(nextWeek)} />
            <small>{f.week ? '' : `Next in this batch: ${nextWeek}`}</small>
          </label>
        </div>
        <label className="field">
          <span>Topic (the week's name)</span>
          <input className="input" value={f.topic} onChange={set('topic')} placeholder="Games & Tournaments" maxLength={60} />
        </label>

        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 700, marginBottom: 8 }}>Days this week</legend>
          <div className="grid3">
            {KINDS.map(([k, name]) => (
              <label className="field" key={k}>
                <span>{name} days</span>
                <select className="input" value={f[k]} onChange={set(k)}>
                  {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            ))}
          </div>
          <label className="check" style={{ marginTop: 12 }}>
            <input type="checkbox" checked={f.sectional} onChange={set('sectional')} />
            <span>Weekly sectional, after the Surprise days</span>
          </label>
        </fieldset>

        <div className="grid3">
          <label className="field"><span>Pre-quiz minutes</span><input className="input" type="number" min="1" max="600" value={f.preMin} onChange={set('preMin')} /></label>
          <label className="field"><span>Quiz minutes</span><input className="input" type="number" min="1" max="600" value={f.postMin} onChange={set('postMin')} /></label>
          <label className="field"><span>Sectional minutes</span><input className="input" type="number" min="1" max="600" value={f.secMin} onChange={set('secMin')} /></label>
        </div>

        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 700, marginBottom: 8 }}>Dates</legend>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <label className="field" style={{ maxWidth: 220 }}>
              <span>First day</span>
              <input className="input" type="date" value={first} onChange={(e) => setFirst(e.target.value)} />
            </label>
            <button type="button" className="btn ghost small" onClick={fill} disabled={!first}>Fill one day apart</button>
          </div>
          <small style={{ display: 'block', marginTop: 8 }}>Or set each date below. A quiz without a date stays a locked draft until you schedule or start it.</small>

          <div className="weekplan">
            <table>
              <thead><tr><th>Day</th><th>Date</th><th>Pre-quiz starts</th><th>Quiz starts</th></tr></thead>
              <tbody>
                {days.map((d) => {
                  const slot = (p) => {
                    if (!d.parts.includes(p)) return <td className="muted small">{d.type === 'surprise' ? 'Pre-quiz only' : ''}</td>
                    const k = slotKey(d.type, d.no, p)
                    if (taken.has(k)) return <td className="muted small">Already there</td>
                    return (
                      <td>
                        <input className="input" type="time" aria-label={`${d.label} ${p === 'post' ? 'Quiz' : p === 'pre' ? 'Pre-quiz' : ''} time`} value={timeOf(d, p)}
                          onChange={(e) => setTimes({ ...times, [k]: e.target.value })} />
                      </td>
                    )
                  }
                  return (
                    <tr key={d.key}>
                      <th scope="row"><span className={`daychip d-${d.type}`}>{d.label}</span></th>
                      <td>
                        <input className="input" type="date" aria-label={`${d.label} date`} value={dates[d.key] || ''} onChange={(e) => setDates({ ...dates, [d.key]: e.target.value })} />
                        {dates[d.key] && <span className="muted small wday">{niceDate(dates[d.key])}</span>}
                      </td>
                      {d.type === 'sectional'
                        ? <td colSpan={2}>
                            <input className="input" type="time" aria-label="Sectional time" value={timeOf(d, '')} onChange={(e) => setTimes({ ...times, [slotKey('sectional', 0, '')]: e.target.value })} style={{ maxWidth: 160 }} />
                            <span className="muted small" style={{ marginLeft: 10 }}>{taken.has(slotKey('sectional', 0, '')) ? 'Already there' : 'Your time'}</span>
                          </td>
                        : <>{slot('pre')}{slot('post')}</>}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </fieldset>

        <section>
          <p><b>{toMake.length}</b> {toMake.length === 1 ? 'quiz' : 'quizzes'} will be made{plan.length > toMake.length ? `, ${plan.length - toMake.length} already in Week ${week} are skipped` : ''}:</p>
          <ul className="planlist">
            {plan.map((x) => (
              <li key={slotKey(x.d.type, x.d.no, x.p)} className={x.skip ? 'skip' : ''}>
                <span>{x.title || '(topic missing)'}</span>
                <span className="muted small">{x.skip ? 'already there' : x.date && x.time ? `${niceDate(x.date)}, ${x.time}` : 'no date yet'}</span>
              </li>
            ))}
          </ul>
        </section>
        {inWeek.length > 0 && <div className="notice plain">Week {week} of {f.batch.trim()} already has {inWeek.length} {inWeek.length === 1 ? 'quiz' : 'quizzes'}. Only the missing ones are made.</div>}
        {err && <p className="error" role="alert">{err}</p>}
        <div className="row">
          <button className="btn" disabled={busy || toMake.length === 0}>{busy ? 'Making' : `Make ${toMake.length} ${toMake.length === 1 ? 'quiz' : 'quizzes'}`}</button>
          <Link className="btn ghost" to="/admin">Cancel</Link>
        </div>
      </form>
    </main>
  )
}
