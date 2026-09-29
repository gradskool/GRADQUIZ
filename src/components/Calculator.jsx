import { useEffect, useRef, useState } from 'react'

// A basic on-screen calculator like the one in CAT: memory keys, square root, percent, 1/x, sign.
// It floats over the quiz; drag it by its title bar.

const fmt = (n) => {
  if (!Number.isFinite(n)) return 'Error'
  const r = parseFloat(n.toPrecision(12))
  const t = String(r)
  return t.length > 16 ? r.toExponential(8) : t
}
const apply = (a, op, b) => (op === '+' ? a + b : op === '−' ? a - b : op === '×' ? a * b : op === '÷' ? a / b : b)

export default function Calculator({ onClose }) {
  const [disp, setDisp] = useState('0')
  const [acc, setAcc] = useState(null) // the number waiting for an operator
  const [op, setOp] = useState(null)
  const [fresh, setFresh] = useState(true) // the next digit starts a new number
  const [mem, setMem] = useState(0)
  const [pos, setPos] = useState(null)
  const drag = useRef(null)
  const box = useRef(null)

  const val = () => parseFloat(disp) || 0
  const show = (n) => { setDisp(fmt(n)); setFresh(true) }
  const error = disp === 'Error'

  function digit(d) {
    if (error || fresh) { setDisp(d === '.' ? '0.' : d); setFresh(false); return }
    if (d === '.' && disp.includes('.')) return
    if (disp.replace(/[-.]/g, '').length >= 14) return
    setDisp(disp === '0' && d !== '.' ? d : disp + d)
  }
  function operator(o) {
    if (error) return
    if (op && !fresh) { const r = apply(acc, op, val()); show(r); setAcc(r) } else { setAcc(val()); setFresh(true) }
    setOp(o)
  }
  function equals() {
    if (error || !op) return
    const r = apply(acc, op, val())
    show(r); setAcc(null); setOp(null)
  }
  function press(k) {
    switch (k) {
      case 'C': setDisp('0'); setAcc(null); setOp(null); setFresh(true); break
      case 'CE': setDisp('0'); setFresh(true); break
      case '←': if (!fresh && !error) setDisp(disp.length > 1 && !(disp.length === 2 && disp.startsWith('-')) ? disp.slice(0, -1) : '0'); break
      case '±': if (!error && disp !== '0') setDisp(disp.startsWith('-') ? disp.slice(1) : `-${disp}`); break
      case '√': if (!error) show(val() < 0 ? NaN : Math.sqrt(val())); break
      case '1/x': if (!error) show(1 / val()); break
      case '%': if (!error) show(op ? (acc * val()) / 100 : val() / 100); break
      case 'MC': setMem(0); break
      case 'MR': setDisp(fmt(mem)); setFresh(true); break
      case 'MS': if (!error) { setMem(val()); setFresh(true) } break
      case 'M+': if (!error) { setMem(mem + val()); setFresh(true) } break
      case 'M−': if (!error) { setMem(mem - val()); setFresh(true) } break
      case '=': equals(); break
      case '+': case '−': case '×': case '÷': operator(k); break
      default: digit(k)
    }
  }

  // drag by the title bar; stays inside the window
  useEffect(() => {
    const move = (e) => {
      if (!drag.current || !box.current) return
      const w = box.current.offsetWidth
      const h = box.current.offsetHeight
      setPos({
        x: Math.min(Math.max(0, e.clientX - drag.current.dx), window.innerWidth - w),
        y: Math.min(Math.max(0, e.clientY - drag.current.dy), window.innerHeight - h),
      })
    }
    const up = () => { drag.current = null }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [])

  const keys = [
    ['MC', 'MR', 'MS', 'M+', 'M−'],
    ['←', 'CE', 'C', '±', '√'],
    ['7', '8', '9', '÷', '%'],
    ['4', '5', '6', '×', '1/x'],
    ['1', '2', '3', '−', '='],
    ['0', '.', '+'],
  ]
  return (
    <div ref={box} className="calc" role="dialog" aria-label="Calculator" style={pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : undefined}>
      <div
        className="calchead"
        onPointerDown={(e) => { const r = box.current.getBoundingClientRect(); drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top } }}
      >
        <span>Calculator</span>
        <button type="button" onClick={onClose} aria-label="Close calculator">×</button>
      </div>
      <div className="calcdisp" aria-live="polite">
        <span className="calcmem">{mem !== 0 ? 'M' : ''}{op ? ` ${fmt(acc)} ${op}` : ''}</span>
        <span className="calcval">{disp}</span>
      </div>
      <div className="calckeys">
        {keys.flat().map((k) => (
          <button key={k} type="button" onClick={() => press(k)}
            className={`${/^[0-9.]$/.test(k) ? 'num' : ''} ${k === '=' ? 'eq' : ''} ${k === '0' ? 'zero' : ''}`}>{k}</button>
        ))}
      </div>
    </div>
  )
}
