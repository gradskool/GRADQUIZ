// Bulk question parser.
// Multiple choice
//   Q1. Question text (can run over lines)
//   A) first option
//   B) second option
//   Ans: B
//   Exp: Optional explanation. It can run over lines until the next blank line.
// Type-in (no options, the answer is the value)
//   Q2. What is 6 x 7?
//   Ans: 42
//   Alternatives go on the same line with a bar, like  Ans: 3.5 | 7/2
const OPTION = /^\(?([A-Fa-f])[).:]\s+(.*\S)\s*$/
const ANS_LETTER = /^(?:ans(?:wer)?|correct)\s*[:\-=]?\s*\(?([A-Fa-f])\)?\s*$/i
const ANS_TEXT = /^(?:ans(?:wer)?|correct)\s*[:=\-]\s*(.+?)\s*$/i
const EXP = /^(?:exp(?:lanation)?|sol(?:ution)?)\s*[:=\-]\s*(.*?)\s*$/i
const QPREFIX = /^(?:q\s*\d*\s*[:.)]|\d+\s*[.)])\s*/i

export function parseQuestions(text) {
  const questions = []
  const errors = []
  let cur = null
  let n = 0

  const fail = (msg) => errors.push(`Question ${n}: ${msg}`)
  const close = () => {
    if (!cur) return
    const explanation = cur.explanation ? cur.explanation.trim() : null
    if (!cur.body) fail('the question text is missing.')
    else if (cur.problem) fail(cur.problem)
    else if (cur.accepted) {
      if (cur.accepted.some((a) => a.length > 40)) fail('an accepted answer is longer than 40 characters.')
      else questions.push({ kind: 'tita', body: cur.body, options: [], correct_index: null, accepted: cur.accepted, explanation })
    } else if (cur.options.length < 2) fail('needs at least two options, or a type-in answer like "Ans: 42".')
    else if (cur.answer == null) fail('has no answer line. Add a line like "Ans: B".')
    else if (cur.options.length > 6) fail('has more than 6 options.')
    else if (cur.answer >= cur.options.length) fail('the answer letter has no matching option.')
    else questions.push({ kind: 'mcq', body: cur.body, options: cur.options, correct_index: cur.answer, accepted: null, explanation })
    cur = null
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) {
      if (cur && cur.done) cur.inExp = false // a blank line ends an explanation
      continue
    }

    if (cur && cur.done) {
      // the answer line was seen, so only an explanation can still belong to this question
      const e = line.match(EXP)
      if (e) { cur.explanation = e[1]; cur.inExp = true; continue }
      if (cur.inExp && !QPREFIX.test(line)) { cur.explanation += '\n' + line; continue }
      close()
    }

    const letter = line.match(ANS_LETTER)
    if (letter && cur) {
      if (cur.options.length === 0) { cur.problem = 'has an answer letter but no options. For a type-in question write the value, like "Ans: 42".'; close() }
      else { cur.answer = letter[1].toUpperCase().charCodeAt(0) - 65; cur.done = true }
      continue
    }

    const typed = line.match(ANS_TEXT)
    if (typed && cur) {
      if (cur.options.length > 0) { cur.problem = 'has options, so the answer must be a letter like "Ans: B".'; close() }
      else { cur.accepted = [...new Map(typed[1].split('|').map((x) => x.trim()).filter(Boolean).map((x) => [x.toLowerCase(), x])).values()].slice(0, 10); cur.done = true }
      continue
    }

    const opt = line.match(OPTION)
    if (opt && cur && cur.body) {
      cur.options.push(opt[2])
      continue
    }

    const startsQ = QPREFIX.test(line)
    if (!cur || (startsQ && cur.options.length > 0)) {
      if (cur) close()
      n += 1
      cur = { body: line.replace(QPREFIX, '').trim(), options: [], answer: null, accepted: null, problem: null, explanation: null, done: false, inExp: false }
    } else if (cur.options.length === 0) {
      cur.body += (cur.body ? '\n' : '') + line.replace(QPREFIX, '')
    } else {
      cur.options[cur.options.length - 1] += ' ' + line
    }
  }
  close()
  return { questions, errors }
}