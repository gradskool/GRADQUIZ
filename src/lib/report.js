// One page PDF report for a submitted attempt. Loaded only when someone presses Download report.
import { jsPDF } from 'jspdf'

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F']
const INK = [0, 0, 0]
const MUTED = [89, 89, 89]
const RULE = [228, 228, 228]
const CORAL = [255, 94, 95]
const CORAL_INK = [196, 42, 43]
const OK = [23, 100, 58]

const num = (n) => {
  if (n == null) return '-'
  const v = Number(n)
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '')
}
const dur = (s) => {
  if (s == null) return '-'
  const t = Math.max(0, Math.round(Number(s)))
  const m = Math.floor(t / 60)
  return m ? `${m}m ${String(t % 60).padStart(2, '0')}s` : `${t}s`
}
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '-')
// jsPDF's built-in fonts cover Latin only, so anything else is dropped rather than printed as junk.
const safe = (s) => String(s ?? '').replace(/[^\x20-\x7E -ÿ]/g, '').trim()

// A letter as this viewer saw it. Students see their own shuffled order, the admin sees the original.
function letterFor(item, orig, admin) {
  if (orig == null) return ''
  if (!admin && Array.isArray(item.opt_map)) {
    const k = item.opt_map.indexOf(Number(orig))
    if (k >= 0) return LETTERS[k]
  }
  return LETTERS[Number(orig)] ?? ''
}

export function buildReport(d, { admin = false } = {}) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const W = 210
  const L = 16
  const R = W - 16
  let y = 18

  const text = (s, x, yy, { size = 10, bold = false, color = INK, align = 'left', font = 'helvetica' } = {}) => {
    doc.setFont(font, bold ? 'bold' : 'normal')
    doc.setFontSize(size)
    doc.setTextColor(...color)
    doc.text(String(s), x, yy, { align })
  }
  const rule = (yy, color = RULE, w = 0.3) => { doc.setDrawColor(...color); doc.setLineWidth(w); doc.line(L, yy, R, yy) }

  // header
  text('GRADQUIZ', L, y, { size: 15, bold: true, font: 'times' })
  text('by GRADSKOOL', L + 31, y, { size: 8.5, color: MUTED })
  text('Performance report', R, y, { size: 9, color: MUTED, align: 'right' })
  y += 4
  doc.setFillColor(...CORAL)
  doc.rect(L, y, R - L, 1.2, 'F')
  y += 11

  text(safe(d.title), L, y, { size: 17, bold: true, font: 'times' })
  y += 7
  text(`${safe(d.name)}  |  ${safe(d.email)}`, L, y, { size: 10, color: MUTED })
  text(`Submitted ${when(d.submitted_at)}`, R, y, { size: 9, color: MUTED, align: 'right' })
  y += 14

  // score and headline numbers
  text(num(d.score), L, y + 4, { size: 34, bold: true, font: 'times' })
  const sw = doc.getTextWidth(num(d.score))
  text(`/ ${num(d.total_marks)}`, L + sw + 3, y + 4, { size: 14, color: MUTED, font: 'times' })

  const attempted = Number(d.correct || 0) + Number(d.wrong || 0)
  const acc = attempted ? Math.round((100 * Number(d.correct || 0)) / attempted) : null
  const tiles = [
    ['Rank', d.rank != null ? `${d.rank} of ${d.of}` : '-'],
    ['Percentile', d.percentile != null ? num(d.percentile) : '-'],
    ['Accuracy', acc == null ? '-' : `${acc}%`],
    ['Time taken', `${dur(d.time_taken_seconds)} of ${d.duration_minutes}m`],
  ]
  let x = 78
  for (const [k, v] of tiles) {
    text(v, x, y, { size: 13, bold: true })
    text(k, x, y + 5, { size: 8.5, color: MUTED })
    x += 29
  }
  y += 14
  rule(y)
  y += 7

  const bonus = (d.items || []).filter((i) => i.bonus).length
  text(`${d.correct ?? 0} correct    ${d.wrong ?? 0} wrong    ${d.unattempted ?? 0} not attempted${bonus ? `    ${bonus} bonus` : ''}`, L, y, { size: 10 })
  text(`Class average ${num(d.class_avg)}   |   Top score ${num(d.class_top)}`, R, y, { size: 9, color: MUTED, align: 'right' })
  y += 8

  // time insight
  const items = d.items || []
  const sum = (arr) => arr.reduce((a, i) => a + Number(i.time || 0), 0)
  const tRight = sum(items.filter((i) => i.ok === true && !i.bonus))
  const tWrong = sum(items.filter((i) => i.ok === false))
  const tSkip = sum(items.filter((i) => i.ok == null))
  const slow = items
    .map((it, i) => ({ n: i + 1, t: Number(it.time || 0), avg: Number(it.avg_time || 0), ok: it.ok }))
    .filter((r) => r.avg > 0 && r.t >= 2 * r.avg && r.t >= 60)
  text('Where the time went', L, y, { size: 10.5, bold: true })
  y += 5.5
  text(`${dur(tRight)} on questions you got right, ${dur(tWrong)} on wrong ones, ${dur(tSkip)} on ones you left.`, L, y, { size: 9.5 })
  y += 5
  if (slow.length) {
    text(`Took twice the class average on Q${slow.slice(0, 8).map((r) => r.n).join(', Q')}${slow.length > 8 ? ' and more' : ''}.`, L, y, { size: 9.5, color: CORAL_INK })
    y += 5
  }
  if (admin && Number(d.tabs) > 0) {
    text(`Left the quiz tab ${d.tabs} time${Number(d.tabs) === 1 ? '' : 's'}, ${dur(d.away)} away in total.`, L, y, { size: 9.5, color: MUTED })
    y += 5
  }
  y += 4

  // question table
  const cols = d.with_key
    ? [['Q', L], ['Result', L + 12], ['Your answer', L + 42], ['Correct', L + 82], ['Your time', L + 128], ['Class avg', L + 153]]
    : [['Q', L], ['Result', L + 14], ['Your time', L + 60], ['Class avg', L + 95]]
  const head = () => {
    for (const [h, cx] of cols) text(h, cx, y, { size: 8.5, bold: true, color: MUTED })
    y += 2
    rule(y, INK, 0.4)
    y += 4.6
  }
  head()
  const rowH = items.length > 30 ? 4.6 : 5.4
  const fs = items.length > 30 ? 8 : 9
  items.forEach((it, i) => {
    if (y > 282) {
      doc.addPage()
      y = 18
      head()
    }
    const res = it.bonus ? 'Bonus' : it.ok === true ? 'Right' : it.ok === false ? 'Wrong' : 'Skipped'
    const col = it.bonus || it.ok === true ? OK : it.ok === false ? CORAL_INK : MUTED
    const cells = d.with_key
      ? [
          `${i + 1}`,
          res,
          it.your == null ? '-' : it.kind === 'mcq' ? letterFor(it, it.your, admin) : safe(it.your).slice(0, 18),
          it.kind === 'mcq' ? letterFor(it, it.correct, admin) : safe((it.correct || []).join(' / ')).slice(0, 22),
          it.time != null ? dur(it.time) : '-',
          it.avg_time != null ? dur(it.avg_time) : '-',
        ]
      : [`${i + 1}`, res, it.time != null ? dur(it.time) : '-', it.avg_time != null ? dur(it.avg_time) : '-']
    cells.forEach((c, k) => text(c, cols[k][1], y, { size: fs, bold: k === 1, color: k === 1 ? col : INK }))
    y += rowH * 0.35
    rule(y)
    y += rowH * 0.65
  })

  // footer
  const pages = doc.getNumberOfPages()
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p)
    text('Percentile is the share of students who submitted with this score or lower. Rank and percentile are as of the date below.', L, 289, { size: 7.5, color: MUTED })
    text(`Made ${when(new Date().toISOString())}${pages > 1 ? `   |   Page ${p} of ${pages}` : ''}`, R, 293, { size: 7.5, color: MUTED, align: 'right' })
  }

  const file = `${safe(d.name).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'student'}-${d.code}-report.pdf`
  doc.save(file)
  return file
}
