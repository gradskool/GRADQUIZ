import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Brand from '../components/Brand.jsx'
import { rpc } from '../lib/supabase.js'

export default function Home() {
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const nav = useNavigate()

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
            <button className="btn" disabled={busy}>{busy ? 'Checking' : 'Continue'}</button>
          </form>
        </div>
      </main>
    </>
  )
}
