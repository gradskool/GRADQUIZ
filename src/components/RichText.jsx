import { useEffect, useState } from 'react'
import MathText from './MathText.jsx'

// Question text with pictures and tables, for LRDI sets and charts.
//   ![](https://…/chart.png)      a picture on its own line (the admin's Add image button writes this)
//   | Team | Won | Lost |          a table: rows start with a bar
//   |------|-----|------|          optional line under the heading row
//   | A    | 3   | 1    |
// Everything else is text with maths, exactly as before.

const IMG = /^!\[([^\]]*)\]\(((?:https?:\/\/|\/)[^\s)]+)\)\s*$/
const ROW = /^\|.*\|\s*$/
const RULE = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

export const hasRich = (s) => typeof s === 'string' && /^\s*(!\[[^\]]*\]\(|\|)/m.test(s)

// For places that show a line of plain text (result tables, previews).
export const plainText = (s) => String(s || '')
  .split('\n')
  .map((l) => (IMG.test(l.trim()) ? '[image]' : RULE.test(l.trim()) ? '' : ROW.test(l.trim()) ? l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).join('  ') : l))
  .filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== ''))
  .join('\n')
  .trim()

function blocks(s) {
  const out = []
  let text = []
  const flush = () => { if (text.length) { out.push({ t: 'text', v: text.join('\n') }); text = [] } }
  const lines = s.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const img = line.match(IMG)
    if (img) { flush(); out.push({ t: 'img', alt: img[1], src: img[2] }); continue }
    if (ROW.test(line) && line.length > 1) {
      const rows = []
      while (i < lines.length && ROW.test(lines[i].trim()) && lines[i].trim().length > 1) { rows.push(lines[i].trim()); i++ }
      i--
      const cells = (r) => r.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim())
      const widths = new Set(rows.filter((r) => !RULE.test(r)).map((r) => cells(r).length))
      // a table has two or more rows of the same width; anything else (like |x| = 3) stays text
      if (rows.length < 2 || widths.size !== 1 || [...widths][0] < 2) { text.push(...lines.slice(i - rows.length + 1, i + 1)); continue }
      flush()
      const head = rows.length > 1 && RULE.test(rows[1]) ? cells(rows[0]) : null
      const body = rows.filter((r, k) => !RULE.test(r) && !(head && k === 0)).map(cells)
      out.push({ t: 'table', head, body })
      continue
    }
    text.push(lines[i])
  }
  flush()
  // trim blank edges around pictures and tables
  return out.map((b) => (b.t === 'text' ? { ...b, v: b.v.replace(/^\n+|\n+$/g, '') } : b)).filter((b) => b.t !== 'text' || b.v.trim())
}

// paragraphs: each line of text is its own paragraph with space between (reading passages)
export default function RichText({ text, as = 'div', className, style, paragraphs = false }) {
  const s = text == null ? '' : String(text)
  const [zoom, setZoom] = useState(null)
  useEffect(() => {
    if (!zoom) return
    const esc = (e) => { if (e.key === 'Escape') setZoom(null) }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [zoom])

  if (!hasRich(s) && !paragraphs) return <MathText as={as} className={className} style={style} text={s} />
  return (
    <div className={`rich ${className || ''}`} style={style}>
      {blocks(s).map((b, i) => {
        if (b.t === 'img') {
          return (
            <button key={i} type="button" className="qfig" onClick={() => setZoom(b.src)} aria-label="Open the picture full size">
              <img src={b.src} alt={b.alt || 'Figure'} loading="lazy" />
            </button>
          )
        }
        if (b.t === 'table') {
          return (
            <div key={i} className="qtable-wrap">
              <table className="qtable">
                {b.head && <thead><tr>{b.head.map((c, k) => <th key={k}><MathText text={c} /></th>)}</tr></thead>}
                <tbody>{b.body.map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j}><MathText text={c} /></td>)}</tr>)}</tbody>
              </table>
            </div>
          )
        }
        if (paragraphs) {
          // blank lines mark paragraphs when the text has them; otherwise every line is a paragraph
          const paras = /\n\s*\n/.test(b.v) ? b.v.split(/\n\s*\n+/) : b.v.split(/\n+/)
          return paras.filter((l) => l.trim()).map((l, k) => <MathText key={`${i}-${k}`} as="p" className="richtext para" text={l.trim()} />)
        }
        return <MathText key={i} as="p" className="richtext" text={b.v} />
      })}
      {zoom && (
        <div className="zoom" role="dialog" aria-label="Picture" onClick={() => setZoom(null)}>
          <img src={zoom} alt="" />
          <span className="zoomclose">Close</span>
        </div>
      )}
    </div>
  )
}
