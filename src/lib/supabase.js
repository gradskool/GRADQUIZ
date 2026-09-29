import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

export const configured = Boolean(url && key)
export const supabase = createClient(url || 'http://localhost', key || 'missing')

const MESSAGES = {
  BAD_NAME: 'Enter your full name.',
  BAD_EMAIL: 'Enter a valid email address.',
  BAD_PIN: 'Choose a PIN with 4 to 6 digits.',
  QUIZ_NOT_FOUND: 'No quiz matches that code. Check it and try again.',
  QUIZ_NOT_STARTED: 'This quiz has not started yet.',
  QUIZ_ENDED: 'This quiz has ended.',
  ALREADY_ATTEMPTED: 'This email has already been used for this quiz. If you attempted it, use Find your result with your email and PIN. If you forgot your PIN, ask your instructor.',
  INVALID_ATTEMPT: 'Your attempt could not be found.',
  NOT_ADMIN: 'This account is not an admin.',
  NO_QUESTIONS: 'Add at least one question first.',
  BAD_TRANSITION: 'That change is not allowed for this quiz.',
  REVIEW_NOT_AVAILABLE: 'Answers are not open yet.',
  QUIZ_LOCKED: 'This quiz is locked. Questions and marking can only change while it is a draft.',
  NOT_INVITED: 'This email is not on the list for this quiz. Use the email your instructor has for you, or ask them to add it.',
  OTP_MISSING: 'Press Send code first, then type the code from your email.',
  BAD_OTP: 'That code is wrong. Check the latest email and try again.',
  OTP_EXPIRED: 'That code has expired. Press Resend code to get a new one.',
  OTP_LOCKED: 'Too many wrong codes. Press Resend code to get a new one.',
  OTP_WAIT: 'A code was just sent. Wait a minute before asking for another.',
  SEND_FAILED: 'The email could not be sent. Try again in a minute, or tell your instructor.',
  NOT_SET_UP: 'Email codes are not set up yet. Tell your instructor.',
  SERVER: 'Something went wrong on our side. Try again.',
  PRACTICE_OFF: 'Practice is not open for this quiz.',
  PRACTICE_NOT_OPEN: 'Practice is only for students who attempted this quiz.',
  REPORT_NOT_AVAILABLE: 'The report is available once scores are shown.',
}

export class AppError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export function toAppError(error) {
  const raw = String(error?.message || error || '')
  const code = Object.keys(MESSAGES).find((k) => raw.includes(k))
  if (code) return new AppError(code, MESSAGES[code])
  if (/quizzes_code_key/i.test(raw)) {
    return new AppError('CODE_TAKEN', 'That code is already used by another quiz.')
  }
  if (/failed to fetch|network|load failed/i.test(raw)) {
    return new AppError('NETWORK', 'Network problem. Check your connection and try again.')
  }
  return new AppError('UNKNOWN', raw || 'Something went wrong. Try again.')
}

export async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args)
  if (error) throw toAppError(error)
  return data
}

// Emails the code for an Invited only quiz. Returns { wait } when a code was sent less than a minute ago.
export async function sendQuizCode(code, email) {
  let res
  try {
    res = await fetch('/.netlify/functions/send-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, email }),
    })
  } catch (e) {
    throw toAppError(e)
  }
  const data = await res.json().catch(() => ({ error: 'SERVER' }))
  if (data.ok) return {}
  if (data.error === 'OTP_WAIT') return { wait: data.wait || 60 }
  throw toAppError(data.error || 'SERVER')
}

export function check(result) {
  if (result.error) throw toAppError(result.error)
  return result.data
}