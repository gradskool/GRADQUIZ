import { useEffect, useState } from 'react'

// Maths in questions, options and explanations.
//   $\frac{3}{4}$  or  \( \frac{3}{4} \)   inline
//   $$ x^2 + y^2 $$  or  \[ ... \]          on its own line
// Money stays plain text: "$5 and $10" is not maths, because a closing $ cannot be followed by a digit
// and must touch the maths unless the inside is clearly maths (has \ ^ _ { } or =). Write \$ for a literal $.
// KaTeX only loads on pages that actually have maths.

let katexPromise
const loadKatex = () =>
  (katexPromise ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([m]) => m.default))

export function splitMath(s) {
  const out = []
  let buf = ''
  let i = 0
  const push = () => { if (buf) { out.push({ math: false, v: buf }); buf = '' } }
  const block = (open, close, display) => {
    if (!s.startsWith(open, i)) return false
    const j = s.indexOf(close, i + open.length)
    if (j <= i + open.length) return false
    push()
    out.push({ math: true, v: s.slice(i + open.length, j), display })
    i = j + close.length
    return true
  }
  while (i < s.length) {
    if (s[i] === '\\' && s[i + 1] === '$') { buf += '$'; i += 2; continue }
    if (block('$$', '$$', true) || block('\\[', '\\]', true) || block('\\(', '\\)', false)) continue
    if (s[i] === '$' && s[i + 1] && !/\s/.test(s[i + 1])) {
      let j = i + 1
      let found = -1
      while ((j = s.indexOf('$', j)) !== -1) {
        const strict = !/\s/.test(s[j - 1])
        // "$3^3 = $" still counts: a space before the closing $ is fine when the inside is clearly maths
        const mathy = /[\\^_{}=]/.test(s.slice(i + 1, j))
        if (j > i + 1 && s[j - 1] !== '\\' && !/\d/.test(s[j + 1] || '') && (strict || mathy)) { found = j; break }
        j += 1
      }
      if (found !== -1 && !/[\n$]/.test(s.slice(i + 1, found))) {
        push()
        out.push({ math: true, v: s.slice(i + 1, found), display: false })
        i = found + 1
        continue
      }
    }
    buf += s[i]
    i += 1
  }
  push()
  return out
}

export function hasMath(s) {
  return typeof s === 'string' && /[$\\]/.test(s) && splitMath(s).some((t) => t.math)
}

export default function MathText({ text, as: Tag = 'span', className, style }) {
  const s = text == null ? '' : String(text)
  const math = hasMath(s)
  const [katex, setKatex] = useState(null)

  useEffect(() => {
    if (!math) return
    let alive = true
    loadKatex().then((k) => { if (alive) setKatex(k) }).catch(() => { /* show the plain text */ })
    return () => { alive = false }
  }, [math])

  if (!math || !katex) return <Tag className={className} style={style}>{s}</Tag>
  return (
    <Tag className={className} style={style}>
      {splitMath(s).map((t, i) =>
        t.math
          ? <span key={i} className={t.display ? 'mathblock' : 'mathinline'} dangerouslySetInnerHTML={{ __html: katex.renderToString(t.v, { displayMode: t.display, throwOnError: false }) }} />
          : <span key={i}>{t.v}</span>)}
    </Tag>
  )
}
