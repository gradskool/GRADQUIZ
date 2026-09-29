import { useCallback, useEffect, useMemo, useState } from 'react'
import { check, supabase } from '../../lib/supabase.js'
import { useToast } from '../../components/Toast.jsx'
import { copyText } from '../../lib/util.js'

// Pulls every email out of whatever was pasted: one per line, commas, or a column from a sheet.
const EMAIL_RE = /[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"']+/g
const extractEmails = (text) => [...new Set((text.match(EMAIL_RE) || []).map((e) => e.toLowerCase().replace(/\.+$/, '')))]

// Programs (FYQ, LRDI…) and their student lists. A roster program only lets listed emails start its quizzes.
export default function Programs() {
  const toast = useToast()
  const [programs, setPrograms] = useState(null)
  const [members, setMembers] = useState([])
  const [counts, setCounts] = useState({})
  const [devices, setDevices] = useState({}) // email -> trusted devices
  const [sel, setSel] = useState(() => { try { return localStorage.getItem('gradquiz:admin:program') || 'LRDI' } catch { return 'LRDI' } })
  const [text, setText] = useState('')
  const [filter, setFilter] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [newName, setNewName] = useState('')

  const load = useCallback(async () => {
    try {
      const p = check(await supabase.from('programs').select('name, roster_only, verify_device').order('name'))
      setPrograms(p)
      const m = check(await supabase.from('program_members').select('program, email').order('email'))
      setMembers(m)
      const q = check(await supabase.from('quizzes').select('program'))
      const c = {}
      q.forEach((r) => { c[r.program] = (c[r.program] || 0) + 1 })
      setCounts(c)
      const d = await supabase.from('trusted_devices').select('email').gt('expires_at', new Date().toISOString())
      if (!d.error) { const m = {}; d.data.forEach((r) => { m[r.email] = (m[r.email] || 0) + 1 }); setDevices(m) }
    } catch (e) {
      setErr(e.message)
    }
  }, [])
  useEffect(() => { load() }, [load])

  const current = programs?.find((p) => p.name === sel) || programs?.[0]
  useEffect(() => { try { if (current) localStorage.setItem('gradquiz:admin:program', current.name) } catch { /* ignore */ } }, [current])
  const list = useMemo(() => members.filter((m) => m.program === current?.name).map((m) => m.email), [members, current])
  const found = useMemo(() => extractEmails(text), [text])
  const fresh = found.filter((e) => !list.includes(e))
  const shown = filter ? list.filter((e) => e.includes(filter.toLowerCase())) : list

  async function add() {
    setErr('')
    setBusy(true)
    try {
      if (fresh.length) {
        check(await supabase.from('program_members').upsert(fresh.map((email) => ({ program: current.name, email })), { onConflict: 'program,email', ignoreDuplicates: true }))
      }
      toast(`${fresh.length} ${fresh.length === 1 ? 'email' : 'emails'} added to ${current.name}`)
      setText('')
      await load()
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  async function remove(email) {
    if (!window.confirm(`Remove ${email} from ${current.name}? They can no longer start ${current.name} quizzes.`)) return
    try {
      check(await supabase.from('program_members').delete().eq('program', current.name).eq('email', email))
      await load()
    } catch (e) { setErr(e.message) }
  }
  async function setRoster(on) {
    try {
      check(await supabase.from('programs').update({ roster_only: on }).eq('name', current.name))
      toast(on ? `${current.name} is now for listed students only` : `${current.name} is now open to anyone with the code`)
      await load()
    } catch (e) { setErr(e.message) }
  }
  async function setVerify(on) {
    try {
      check(await supabase.from('programs').update({ verify_device: on }).eq('name', current.name))
      toast(on ? 'Students confirm each new device with an email code' : 'No email code for this program')
      await load()
    } catch (e) { setErr(e.message) }
  }
  async function forget(email) {
    if (!window.confirm(`Forget the trusted devices of ${email}? Their next quiz asks for an email code again.`)) return
    try {
      check(await supabase.from('trusted_devices').delete().eq('email', email))
      toast('Devices forgotten')
      await load()
    } catch (e) { setErr(e.message) }
  }

  async function createProgram(e) {
    e.preventDefault()
    const name = newName.trim().replace(/\s+/g, ' ')
    if (!name) return
    try {
      check(await supabase.from('programs').insert({ name, roster_only: true }))
      setNewName('')
      setSel(name)
      await load()
      toast(`${name} created`)
    } catch (ex) { setErr(/duplicate|programs_pkey/i.test(ex.message) ? 'A program with that name exists.' : ex.message) }
  }

  return (
    <main className="page">
      <h1>Programs</h1>
      <p className="muted" style={{ marginTop: 10, maxWidth: 720 }}>
        Every quiz belongs to a program. An open program lets anyone with the code attempt. A listed-students program lets only the emails below start its quizzes.
        Students see only their own programs in the library.
      </p>
      {err && <p className="error" role="alert" style={{ marginTop: 16 }}>{err}</p>}
      {programs === null && !err && <p className="muted" style={{ marginTop: 16 }}>Loading.</p>}

      {programs && current && (
        <>
          <div className="libtabs" role="tablist" aria-label="Program" style={{ marginTop: 24 }}>
            {programs.map((p) => (
              <button key={p.name} type="button" role="tab" className="libtab" aria-selected={p.name === current.name} onClick={() => setSel(p.name)}>
                {p.name}
              </button>
            ))}
          </div>

          <section className="block">
            <div className="row between" style={{ alignItems: 'baseline' }}>
              <h2 style={{ marginBottom: 0 }}>{current.name}</h2>
              <span className="muted small">{counts[current.name] || 0} quizzes · {list.length} listed students</span>
            </div>
            <div className="kinds" role="radiogroup" aria-label="Who can attempt" style={{ marginTop: 14 }}>
              <button type="button" role="radio" aria-checked={!current.roster_only} onClick={() => current.roster_only && setRoster(false)}>Open to anyone with the code</button>
              <button type="button" role="radio" aria-checked={current.roster_only} onClick={() => !current.roster_only && setRoster(true)}>Listed students only</button>
            </div>
            {current.roster_only && list.length === 0 && (
              <div className="notice" style={{ marginTop: 14 }}>Nobody is listed yet, so nobody can start {current.name} quizzes.</div>
            )}

            {current.roster_only && (
              <>
                <label className="check" style={{ marginTop: 16 }}>
                  <input type="checkbox" checked={Boolean(current.verify_device)} onChange={(e) => setVerify(e.target.checked)} />
                  <span>
                    <b>Email code once per device.</b> The first time a student starts one of the {current.name} quizzes on a phone or computer, a 6 digit code is emailed to them.
                    That device is then trusted for 60 days. Stops anyone who only knows another student's email. Uses the same Gmail setup as Invited only.
                  </span>
                </label>
                <div className="stack" style={{ marginTop: 20 }}>
                  <label className="field">
                    <span>Add students</span>
                    <textarea className="textarea" style={{ minHeight: 110 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={'amit@gmail.com\nriya@gmail.com\nor paste a column straight from a sheet'} />
                    <small>One per line, commas, or pasted from a sheet. Names and other text are ignored.</small>
                  </label>
                  {text.trim() && (
                    <p className="small"><b>{found.length}</b> found{found.length - fresh.length > 0 ? `, ${found.length - fresh.length} already listed` : ''}.</p>
                  )}
                  <div><button className="btn small" onClick={add} disabled={busy || fresh.length === 0}>{busy ? 'Adding' : `Add ${fresh.length || ''} to ${current.name}`.replace('  ', ' ')}</button></div>
                </div>

                {list.length > 0 && (
                  <div style={{ marginTop: 24 }}>
                    <div className="row between">
                      <input className="input" style={{ maxWidth: 320 }} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search emails" aria-label="Search emails" />
                      <button className="btn ghost small" onClick={async () => { await copyText(list.join('\n')); toast('Emails copied') }}>Copy all</button>
                    </div>
                    <ul className="invites" style={{ marginTop: 12 }}>
                      {shown.map((e) => (
                        <li key={e}>
                          <span>{e}{current.verify_device && devices[e] ? <span className="muted small"> · {devices[e]} trusted {devices[e] === 1 ? 'device' : 'devices'}</span> : ''}</span>
                          <span className="row" style={{ gap: 14 }}>
                            {devices[e] > 0 && <button className="link" onClick={() => forget(e)}>Forget devices</button>}
                            <button className="link danger" onClick={() => remove(e)}>Remove</button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
            {!current.roster_only && <p className="muted small" style={{ marginTop: 14 }}>Open programs need no list. Students join the library for it by attempting any of its quizzes.</p>}
          </section>

          <section className="block">
            <h2>New program</h2>
            <form className="row" onSubmit={createProgram} style={{ marginTop: 10 }}>
              <input className="input" style={{ maxWidth: 260 }} value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={40} placeholder="e.g. VARC" aria-label="Program name" />
              <button className="btn ghost small" disabled={!newName.trim()}>Create</button>
            </form>
            <p className="muted small" style={{ marginTop: 8 }}>New programs start as listed students only.</p>
          </section>
        </>
      )}
    </main>
  )
}
