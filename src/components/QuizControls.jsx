import { useState } from 'react'
import { rpc } from '../lib/supabase.js'
import { useToast } from './Toast.jsx'

// Start and End buttons with a confirm step.
export default function QuizControls({ quiz, questionCount, onChange, blocked = '' }) {
  const [ask, setAsk] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const toast = useToast()

  async function run(status) {
    setBusy(true)
    setErr('')
    try {
      await rpc('set_quiz_status', { p_quiz: quiz.id, p_status: status })
      setAsk(null)
      toast(status === 'live' ? 'Quiz started' : 'Quiz ended')
      onChange()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="row">
        {quiz.status === 'draft' && (
          <button className="btn" onClick={() => setAsk('live')} disabled={questionCount === 0 || Boolean(blocked)}>Start quiz</button>
        )}
        {quiz.status === 'live' && (
          <button className="btn dark" onClick={() => setAsk('ended')}>End quiz</button>
        )}
        {quiz.status === 'draft' && blocked && <span className="error small">{blocked}</span>}
        {quiz.status === 'draft' && !blocked && questionCount === 0 && <span className="muted small">Add a question to start.</span>}
      </div>
      {err && !ask && <p className="error" role="alert">{err}</p>}

      {ask && (
        <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="ctl-h">
          <div className="dialog">
            {ask === 'live' ? (
              <>
                <h2 id="ctl-h">Start this quiz?</h2>
                <p>Students with the code {quiz.code} can begin right away. Questions, timer and marking lock once you start.</p>
              </>
            ) : (
              <>
                <h2 id="ctl-h">End this quiz?</h2>
                <p>New students can no longer enter. Anyone already working keeps their own timer and can finish. You cannot reopen the quiz.</p>
              </>
            )}
            {err && <p className="error" role="alert" style={{ marginTop: 12 }}>{err}</p>}
            <div className="row">
              <button className={`btn ${ask === 'ended' ? 'dark' : ''}`} onClick={() => run(ask)} disabled={busy} autoFocus>
                {busy ? 'Working' : ask === 'live' ? 'Start quiz' : 'End quiz'}
              </button>
              <button className="btn ghost" onClick={() => { setAsk(null); setErr('') }} disabled={busy}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}