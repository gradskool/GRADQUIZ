import { useEffect, useState } from 'react'
import { Link, Outlet } from 'react-router-dom'
import Brand from '../../components/Brand.jsx'
import { supabase } from '../../lib/supabase.js'

function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function go(e) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (error) setErr('Wrong email or password.')
    setBusy(false)
  }

  return (
    <>
      <header className="bar"><Brand /></header>
      <main className="page narrow">
        <form className="stack" onSubmit={go}>
          <h1>Admin sign in</h1>
          <label className="field">
            <span>Email</span>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
          </label>
          <label className="field">
            <span>Password</span>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </label>
          {err && <p className="error" role="alert">{err}</p>}
          <div><button className="btn" disabled={busy}>{busy ? 'Signing in' : 'Sign in'}</button></div>
        </form>
      </main>
    </>
  )
}

export default function AdminGate() {
  const [session, setSession] = useState(undefined)
  const [isAdmin, setIsAdmin] = useState(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  const uid = session?.user?.id
  useEffect(() => {
    if (!uid) { setIsAdmin(null); return }
    supabase.from('admins').select('user_id').eq('user_id', uid).maybeSingle()
      .then(({ data }) => setIsAdmin(Boolean(data)))
  }, [uid])

  if (session === undefined) return <p className="page muted">Loading.</p>
  if (!session) return <Login />

  if (isAdmin === null) return <p className="page muted">Checking access.</p>
  if (isAdmin === false) {
    return (
      <>
        <header className="bar"><Brand /></header>
        <main className="page narrow stack">
          <h1>No admin access</h1>
          <p>{session.user.email} is not an admin. Ask the owner to add this account.</p>
          <div><button className="btn ghost" onClick={() => supabase.auth.signOut()}>Sign out</button></div>
        </main>
      </>
    )
  }

  return (
    <>
      <header className="bar">
        <Brand to="/admin" />
        <nav>
          <Link to="/admin">Quizzes</Link>
          <button className="link" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </nav>
      </header>
      <Outlet />
    </>
  )
}
