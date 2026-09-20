import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { check, supabase } from '../../lib/supabase.js'
import { LETTERS, copyText, quizLink } from '../../lib/util.js'
import { parseQuestions } from '../../lib/parse.js'
import { useToast } from '../../components/Toast.jsx'
import QuizControls from '../../components/QuizControls.jsx'

export default function QuizEditor() {
  const { id } = useParams()
  const nav = useNavigate()
  const toast = useToast()
  const [quiz, setQuiz] = useState(null)
  const [qs, setQs] = useState([])
  const [form, setForm] = useState(null)
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(null) // a question id, 'new' or null
  const [bulk, setBulk] = useState(false)
  const [expId, setExpId] = useState(null)
  const [expText, setExpText] = useState('')

  const load = useCallback(async () => {
    try {
      const q = check(await supabase.from('quizzes').select('*').eq('id', id).single())
      const questions = check(await supabase.from('questions').select('*').eq('quiz_id', id).order('position'))
      setQuiz(q)
      setQs(questions)
      setForm((f) => f ?? {
        title: q.title,
        instructions: q.instructions || '',
        code: q.code,
        duration: String(q.duration_minutes),
        correct: String(q.marks_correct),
        wrong: String(q.marks_wrong),
        wrongTita: String(q.marks_wrong_tita),
        show: q.show_score,
        review: q.show_review,
      })
    } catch (e) {
      setErr(e.message)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  if (err && !quiz) return <main className="page"><p className="error" role="alert">{err}</p></main>
  if (!quiz || !form) return <main className="page"><p className="muted">Loading.</p></main>

  const draft = quiz.status === 'draft'
  // True when the form holds edits that are not saved yet. Starting a quiz then would lock the old saved values.
  const dirty =
    form.title.trim() !== quiz.title ||
    form.instructions.trim() !== (quiz.instructions || '') ||
    form.show !== quiz.show_score ||
    form.review !== quiz.show_review ||
    (draft && (
      form.code !== quiz.code ||
      Number(form.duration) !== quiz.duration_minutes ||
      Number(form.correct) !== Number(quiz.marks_correct) ||
      Number(form.wrong) !== Number(quiz.marks_wrong) ||
      Number(form.wrongTita) !== Number(quiz.marks_wrong_tita)
    ))
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })

  async function saveSettings(e) {
    e.preventDefault()
    setErr('')
    const patch = {
      title: form.title.trim() || 'Untitled quiz',
      instructions: form.instructions.trim() || null,
      show_score: form.show,
      show_review: form.review,
    }
    if (draft) {
      const code = form.code.trim().toUpperCase()
      const mins = Number(form.duration)
      const plus = Number(form.correct)
      const minus = Number(form.wrong)
      const minusTita = Number(form.wrongTita)
      if (!/^[A-Z0-9]{4,12}$/.test(code)) return setErr('The code needs 4 to 12 letters or numbers.')
      if (!Number.isInteger(mins) || mins < 1 || mins > 600) return setErr('Time must be a whole number of minutes from 1 to 600.')
      if (!(plus >= 0) || !(minus >= 0) || !(minusTita >= 0)) return setErr('Marks cannot be negative. Enter the penalty as a positive number.')
      Object.assign(patch, { code, duration_minutes: mins, marks_correct: plus, marks_wrong: minus, marks_wrong_tita: minusTita })
    }
    setSaving(true)
    try {
      check(await supabase.from('quizzes').update(patch).eq('id', id))
      toast('Saved')
      await load()
    } catch (ex) {
      setErr(ex.message)
    } finally {
      setSaving(false)
    }
  }

  async function addQuestions(rows) {
    const start = qs.reduce((m, x) => Math.max(m, x.position), 0) + 1
    const payload = rows.map((r, i) => ({ quiz_id: id, position: start + i, ...r }))
    check(await supabase.from('questions').insert(payload))
    toast(rows.length === 1 ? 'Question added' : `${rows.length} questions added`)
    await load()
  }
  async function updateQuestion(qid, row) {
    check(await supabase.from('questions').update(row).eq('id', qid))
    toast('Question saved')
    await load()
  }
  async function saveExplanation(qid) {
    try {
      check(await supabase.from('questions').update({ explanation: expText.trim() || null }).eq('id', qid))
      setExpId(null)
      toast('Explanation saved')
      await load()
    } catch (ex) { setErr(ex.message) }
  }
  async function removeQuestion(qid) {
    if (!window.confirm('Delete this question?')) return
    try {
      check(await supabase.from('questions').delete().eq('id', qid))
      await load()
    } catch (ex) { setErr(ex.message) }
  }
  async function move(i, dir) {
    const a = qs[i]
    const b = qs[i + dir]
    if (!b) return
    try {
      check(await supabase.from('questions').update({ position: b.position }).eq('id', a.id))
      check(await supabase.from('questions').update({ position: a.position }).eq('id', b.id))
      await load()
    } catch (ex) { setErr(ex.message) }
  }
  async function deleteQuiz() {
    if (!window.confirm(`Delete "${quiz.title}" and all its results? This cannot be undone.`)) return
    try {
      check(await supabase.from('quizzes').delete().eq('id', id))
      nav('/admin')
    } catch (ex) { setErr(ex.message) }
  }

  return (
    <main className="page">
      <p><Link to="/admin">All quizzes</Link></p>
      <div className="spacer" />
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1>{quiz.title}</h1>
          <p style={{ marginTop: 10 }}>
            <span className={`status ${quiz.status}`}><i />{quiz.status === 'draft' ? 'Draft' : quiz.status === 'live' ? 'Live' : 'Ended'}</span>
          </p>
        </div>
        <div className="stack" style={{ textAlign: 'right' }}>
          <QuizControls quiz={quiz} questionCount={qs.length} onChange={load} blocked={dirty ? 'Save your settings first.' : ''} />
          <Link to={`/admin/quiz/${id}/results`} className="btn ghost small">View results</Link>
        </div>
      </div>
      {err && <p className="error" role="alert" style={{ marginTop: 16 }}>{err}</p>}

      <div className="spacer" />
      <section className="block">
        <h2>Share</h2>
        <div className="row" style={{ gap: 28 }}>
          <div>
            <p className="muted small">Code</p>
            <p className="codechip" style={{ fontSize: '2rem' }}>{quiz.code}</p>
          </div>
          <div style={{ flex: 1, minWidth: 240 }}>
            <p className="muted small">Direct link</p>
            <p style={{ wordBreak: 'break-all' }}>{quizLink(quiz.code)}</p>
          </div>
          <div className="row">
            <button className="btn ghost small" onClick={async () => { await copyText(quiz.code); toast('Code copied') }}>Copy code</button>
            <button className="btn ghost small" onClick={async () => { await copyText(quizLink(quiz.code)); toast('Link copied') }}>Copy link</button>
          </div>
        </div>
      </section>

      <section className="block">
        <h2>Settings</h2>
        {!draft && <div className="notice plain" style={{ marginBottom: 16 }}>Code, time and marking are locked because this quiz has started. You can still change the title, instructions and score visibility.</div>}
        <form className="stack" onSubmit={saveSettings} noValidate>
          <label className="field">
            <span>Title</span>
            <input className="input" value={form.title} onChange={set('title')} maxLength={120} />
          </label>
          <label className="field">
            <span>Instructions</span>
            <textarea className="textarea" value={form.instructions} onChange={set('instructions')} placeholder="Optional. Students see this before they start." />
          </label>
          <div className="grid3">
            <label className="field">
              <span>Time in minutes</span>
              <input className="input" type="number" min="1" max="600" step="1" value={form.duration} onChange={set('duration')} disabled={!draft} />
            </label>
            <label className="field">
              <span>Marks for a correct answer</span>
              <input className="input" type="number" min="0" step="0.25" value={form.correct} onChange={set('correct')} disabled={!draft} />
            </label>
            <label className="field">
              <span>Marks lost for a wrong multiple choice answer</span>
              <input className="input" type="number" min="0" step="0.25" value={form.wrong} onChange={set('wrong')} disabled={!draft} />
              <small>Enter 1 for a penalty of −1. Use 0 for no negative marking.</small>
            </label>
          </div>
          <label className="field" style={{ maxWidth: 340 }}>
            <span>Marks lost for a wrong type-in answer</span>
            <input className="input" type="number" min="0" step="0.25" value={form.wrongTita} onChange={set('wrongTita')} disabled={!draft} />
            <small>CAT type-in questions lose nothing when wrong, so the default is 0.</small>
          </label>
          <label className="field" style={{ maxWidth: 240 }}>
            <span>Code</span>
            <input className="input codechip" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} disabled={!draft} maxLength={12} />
          </label>
          <label className="check">
            <input type="checkbox" checked={form.show} onChange={set('show')} />
            <span>Show students their score after they submit. Turn this off to release scores later.</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={form.review} onChange={set('review')} />
            <span>Let students review their answers once the quiz has ended and every student has finished. They see their answer, the correct answer and your explanation for every question.</span>
          </label>
          <div className="row">
            <button className="btn" disabled={saving}>{saving ? 'Saving' : 'Save settings'}</button>
            {dirty && <span className="error" role="status">You have unsaved changes.</span>}
          </div>
        </form>
      </section>

      <section className="block">
        <div className="row between">
          <h2 style={{ marginBottom: 0 }}>Questions ({qs.length})</h2>
          {draft && editing !== 'new' && !bulk && (
            <div className="row">
              <button className="btn small" onClick={() => setEditing('new')}>Add question</button>
              <button className="btn ghost small" onClick={() => setBulk(true)}>Paste many</button>
            </div>
          )}
        </div>
        {!draft && <p className="muted" style={{ marginTop: 8 }}>Questions are locked. You can still add or change explanations.</p>}

        {draft && editing === 'new' && (
          <QuestionForm
            onCancel={() => setEditing(null)}
            onSave={async (row) => { await addQuestions([row]); setEditing(null) }}
          />
        )}
        {draft && bulk && (
          <BulkImport
            onCancel={() => setBulk(false)}
            onAdd={async (rows) => { await addQuestions(rows); setBulk(false) }}
          />
        )}

        <div style={{ marginTop: 12 }}>
          {qs.length === 0 && !editing && !bulk && <p className="muted">No questions yet.</p>}
          {qs.map((q, i) => (
            editing === q.id ? (
              <QuestionForm
                key={q.id}
                initial={q}
                onCancel={() => setEditing(null)}
                onSave={async (row) => { await updateQuestion(q.id, row); setEditing(null) }}
              />
            ) : (
              <div className="qrow" key={q.id}>
                <span className="no">{i + 1}</span>
                <div>
                  <p style={{ whiteSpace: 'pre-wrap' }}>{q.body}</p>
                  {q.kind === 'tita' ? (
                    <p className="accepted"><span className="muted">Type-in. Accepted </span><b>{q.accepted.join('  or  ')}</b></p>
                  ) : (
                    <ol>
                      {q.options.map((o, k) => (
                        <li key={k} className={k === q.correct_index ? 'right' : ''}><b>{LETTERS[k]}</b><span>{o}</span></li>
                      ))}
                    </ol>
                  )}
                  {expId === q.id ? (
                    <div className="stack" style={{ marginTop: 12 }}>
                      <label className="field">
                        <span>Explanation</span>
                        <textarea className="textarea" value={expText} onChange={(e) => setExpText(e.target.value)} autoFocus />
                      </label>
                      <div className="row">
                        <button className="btn small" onClick={() => saveExplanation(q.id)}>Save explanation</button>
                        <button className="btn ghost small" onClick={() => setExpId(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    q.explanation && <p className="muted small" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>Explanation. {q.explanation}</p>
                  )}
                </div>
                {!draft && expId !== q.id && (
                  <div className="qactions">
                    <button className="link" onClick={() => { setExpText(q.explanation || ''); setExpId(q.id) }}>{q.explanation ? 'Edit explanation' : 'Add explanation'}</button>
                  </div>
                )}
                {draft && (
                  <div className="qactions">
                    <button className="link" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">Up</button>
                    <button className="link" onClick={() => move(i, 1)} disabled={i === qs.length - 1} aria-label="Move down">Down</button>
                    <button className="link" onClick={() => { setBulk(false); setEditing(q.id) }}>Edit</button>
                    <button className="link danger" onClick={() => removeQuestion(q.id)}>Delete</button>
                  </div>
                )}
              </div>
            )
          ))}
        </div>
      </section>

      <section className="block">
        <button className="link danger" onClick={deleteQuiz}>Delete this quiz</button>
      </section>
    </main>
  )
}

// Text answers match without regard to capitals, so drop repeats that differ only by case.
const uniqueCI = (list) => { const seen = new Set(); return list.filter((x) => { const k = x.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true }) }

function QuestionForm({ initial, onSave, onCancel }) {
  const [kind, setKind] = useState(initial?.kind || 'mcq')
  const [body, setBody] = useState(initial?.body || '')
  const [opts, setOpts] = useState(initial?.kind !== 'tita' && initial?.options?.length ? [...initial.options] : ['', '', '', ''])
  const [correct, setCorrect] = useState(initial?.correct_index ?? 0)
  const [accepted, setAccepted] = useState(initial?.kind === 'tita' ? initial.accepted.join('\n') : '')
  const [expl, setExpl] = useState(initial?.explanation || '')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const setOpt = (i, v) => setOpts(opts.map((o, k) => (k === i ? v : o)))
  const removeOpt = (i) => {
    if (opts.length <= 2) return
    setOpts(opts.filter((_, k) => k !== i))
    setCorrect((c) => (c === i ? 0 : c > i ? c - 1 : c))
  }

  async function submit(e) {
    e.preventDefault()
    const b = body.trim()
    if (!b) return setErr('Write the question.')
    let row
    if (kind === 'tita') {
      const list = uniqueCI(accepted.split('\n').map((x) => x.trim()).filter(Boolean))
      if (list.length === 0) return setErr('Add the accepted answer.')
      if (list.length > 10) return setErr('Use at most 10 accepted answers.')
      if (list.some((x) => x.length > 40)) return setErr('Each accepted answer can be up to 40 characters.')
      row = { kind: 'tita', body: b, options: [], correct_index: null, accepted: list, explanation: expl.trim() || null }
    } else {
      const items = opts.map((t, i) => ({ t: t.trim(), c: i === correct })).filter((x) => x.t)
      if (items.length < 2) return setErr('Add at least two options.')
      const ci = items.findIndex((x) => x.c)
      if (ci < 0) return setErr('Mark the correct option. It cannot be empty.')
      row = { kind: 'mcq', body: b, options: items.map((x) => x.t), correct_index: ci, accepted: null, explanation: expl.trim() || null }
    }
    setBusy(true)
    try {
      await onSave(row)
    } catch (ex) {
      setErr(ex.message)
      setBusy(false)
    }
  }

  return (
    <form className="qform stack" onSubmit={submit} noValidate>
      <div className="kinds" role="radiogroup" aria-label="Question type">
        <button type="button" role="radio" aria-checked={kind === 'mcq'} onClick={() => setKind('mcq')}>Multiple choice</button>
        <button type="button" role="radio" aria-checked={kind === 'tita'} onClick={() => setKind('tita')}>Type-in</button>
      </div>
      <label className="field">
        <span>Question</span>
        <textarea className="textarea" value={body} onChange={(e) => setBody(e.target.value)} autoFocus />
      </label>
      {kind === 'tita' ? (
        <label className="field">
          <span>Accepted answers</span>
          <textarea className="textarea" style={{ minHeight: 72 }} value={accepted} onChange={(e) => setAccepted(e.target.value)} placeholder="42" />
          <small>One per line. Numbers match by value, so 42 and 42.0 both count. Add other forms yourself, like 3.5 and 7/2. Text ignores capitals and extra spaces.</small>
        </label>
      ) : (
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 700, marginBottom: 4 }}>Options. Select the correct one.</legend>
          {opts.map((o, i) => (
            <div className="optrow" key={i}>
              <input type="radio" name="correct" checked={correct === i} onChange={() => setCorrect(i)} aria-label={`Option ${LETTERS[i]} is correct`} />
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <b style={{ fontFamily: 'var(--serif)' }}>{LETTERS[i]}</b>
                <input className="input" value={o} onChange={(e) => setOpt(i, e.target.value)} aria-label={`Option ${LETTERS[i]} text`} />
              </div>
              <button type="button" className="link" onClick={() => removeOpt(i)} disabled={opts.length <= 2}>Remove</button>
            </div>
          ))}
          {opts.length < 6 && <p style={{ marginTop: 10 }}><button type="button" className="link" onClick={() => setOpts([...opts, ''])}>Add option</button></p>}
        </fieldset>
      )}
      <label className="field">
        <span>Explanation (optional)</span>
        <textarea className="textarea" style={{ minHeight: 72 }} value={expl} onChange={(e) => setExpl(e.target.value)} />
        <small>Students see this in the answer review after the quiz ends.</small>
      </label>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row">
        <button className="btn small" disabled={busy}>{busy ? 'Saving' : 'Save question'}</button>
        <button type="button" className="btn ghost small" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  )
}

const SAMPLE = `Q1. What is 15% of 240?
A) 24
B) 30
C) 36
D) 40
Ans: C

Q2. The average of 5 numbers is 12. What is their sum?
A) 17
B) 48
C) 60
D) 72
Ans: C

Q3. What is 6 x 7?
Ans: 42
Exp: Six sevens make forty two.`

function BulkImport({ onAdd, onCancel }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const parsed = useMemo(() => parseQuestions(text), [text])

  async function add() {
    setBusy(true)
    setErr('')
    try {
      await onAdd(parsed.questions)
    } catch (ex) {
      setErr(ex.message)
      setBusy(false)
    }
  }

  return (
    <div className="qform stack">
      <label className="field">
        <span>Paste questions</span>
        <textarea className="textarea" style={{ minHeight: 220 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={SAMPLE} autoFocus />
        <small>One block per question. Multiple choice needs lettered options and an Ans line with the letter. A type-in question has no options, just Ans with the value. Put alternatives on one line with a bar, like Ans: 3.5 | 7/2. Add an optional Exp line after Ans for the explanation.</small>
      </label>
      {text.trim() && (
        <div>
          <p><b>{parsed.questions.length}</b> ready to add.</p>
          {parsed.errors.length > 0 && (
            <ul className="error" style={{ margin: '8px 0 0', paddingLeft: 20 }}>
              {parsed.errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
        </div>
      )}
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row">
        <button className="btn small" onClick={add} disabled={busy || parsed.questions.length === 0 || parsed.errors.length > 0}>
          {busy ? 'Adding' : `Add ${parsed.questions.length || ''} questions`.replace('  ', ' ')}
        </button>
        <button className="btn ghost small" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  )
}