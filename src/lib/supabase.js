import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

export const configured = Boolean(url && key)
export const supabase = createClient(url || 'http://localhost', key || 'missing')

const MESSAGES = {
  BAD_NAME: 'Enter your full name.',
  BAD_EMAIL: 'Enter a valid email address.',
  QUIZ_NOT_FOUND: 'No quiz matches that code. Check it and try again.',
  QUIZ_NOT_STARTED: 'This quiz has not started yet.',
  QUIZ_ENDED: 'This quiz has ended.',
  ALREADY_ATTEMPTED: 'This email has already been used for this quiz.',
  INVALID_ATTEMPT: 'Your attempt could not be found.',
  NOT_ADMIN: 'This account is not an admin.',
  NO_QUESTIONS: 'Add at least one question first.',
  BAD_TRANSITION: 'That change is not allowed for this quiz.',
  QUIZ_LOCKED: 'This quiz is locked. Questions and marking can only change while it is a draft.',
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

export function check(result) {
  if (result.error) throw toAppError(result.error)
  return result.data
}
