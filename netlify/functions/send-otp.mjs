// Emails the 6 digit code for an Invited only quiz.
// The database makes the code (issue_quiz_otp) and checks the invite list. This function only sends it.
//
// Netlify environment variables (Site configuration > Environment variables, scope must include Functions):
//   SUPABASE_URL               same as VITE_SUPABASE_URL (that one is used if this is missing)
//   SUPABASE_SERVICE_ROLE_KEY  Supabase > Project Settings > API > service_role (or secret) key. Never prefix it with VITE_.
//   GMAIL_USER                 the Gmail address that sends the codes
//   GMAIL_APP_PASSWORD         a 16 character app password for that account (needs 2-Step Verification on)
import nodemailer from 'nodemailer'

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
})

let transport
function mailer() {
  transport ??= nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: (process.env.GMAIL_APP_PASSWORD || '').replace(/\s/g, '') },
  })
  return transport
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'METHOD' })

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key || !process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.error('send-otp: missing environment variables')
    return json(500, { error: 'NOT_SET_UP' })
  }

  let body
  try { body = await req.json() } catch { return json(400, { error: 'BAD_REQUEST' }) }
  const code = String(body?.code || '').trim().toUpperCase()
  const email = String(body?.email || '').trim().toLowerCase()
  if (!/^[A-Z0-9]{4,12}$/.test(code)) return json(400, { error: 'QUIZ_NOT_FOUND' })
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: 'BAD_EMAIL' })

  // Legacy service_role keys are JWTs and go in Authorization too. New sb_secret_ keys only go in apikey.
  const headers = { apikey: key, 'Content-Type': 'application/json' }
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`

  let data
  try {
    const r = await fetch(`${url}/rest/v1/rpc/issue_quiz_otp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ p_code: code, p_email: email }),
    })
    data = await r.json()
    if (!r.ok) throw new Error(JSON.stringify(data))
  } catch (e) {
    console.error('send-otp: database call failed', e)
    return json(502, { error: 'SERVER' })
  }

  if (!data?.ok) return json(200, { error: data?.reason || 'SERVER', wait: data?.wait })

  try {
    await mailer().sendMail({
      from: `"GRADSKOOL Quiz" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: `${data.otp} is your code for ${data.title}`,
      text: `Your code for "${data.title}" is ${data.otp}\n\nType it on the quiz page to start. It works for 10 minutes.\nIf you did not ask for this, ignore this email.`,
      html: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#111">
        <p>Your code for <b>${esc(data.title)}</b> is</p>
        <p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:12px 0">${data.otp}</p>
        <p>Type it on the quiz page to start. It works for 10 minutes.</p>
        <p style="color:#666;font-size:13px">If you did not ask for this, ignore this email.</p></div>`,
    })
  } catch (e) {
    console.error('send-otp: email failed', e)
    return json(502, { error: 'SEND_FAILED' })
  }

  return json(200, { ok: true })
}
