import { useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import RichText, { hasRich } from './RichText.jsx'
import { hasMath } from './MathText.jsx'

const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const MAX_BYTES = 5 * 1024 * 1024
const MAX_WIDTH = 1800

// Very wide screenshots are scaled down so they load fast on phones. Charts stay sharp as PNG.
async function shrink(file) {
  if (file.type === 'image/gif') return file
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url })
    if (img.naturalWidth <= MAX_WIDTH) return file
    const c = document.createElement('canvas')
    c.width = MAX_WIDTH
    c.height = Math.round((img.naturalHeight * MAX_WIDTH) / img.naturalWidth)
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    const blob = await new Promise((ok) => c.toBlob(ok, type, 0.9))
    return blob || file
  } catch {
    return file
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function uploadImage(file) {
  if (!TYPES.includes(file.type)) throw new Error('Use a PNG, JPG, WebP or GIF picture.')
  const small = await shrink(file)
  if (small.size > MAX_BYTES) throw new Error('That picture is over 5 MB. Crop it or save it smaller.')
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[small.type || file.type] || 'png'
  const path = `q/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from('quiz-images').upload(path, await small.arrayBuffer(), {
    contentType: small.type || file.type,
    cacheControl: '31536000',
    upsert: false,
  })
  if (error) {
    if (/bucket not found/i.test(error.message)) throw new Error('Picture storage is not set up. Run supabase/patch_sets.sql first.')
    if (/row-level security|unauthorized|403/i.test(error.message)) throw new Error('Only admins can add pictures. Sign in again.')
    throw new Error(error.message)
  }
  return supabase.storage.from('quiz-images').getPublicUrl(path).data.publicUrl
}

// A textarea that takes pictures: paste a screenshot, drop a file, or use Add image.
// Each picture becomes a line like ![](https://…) where the cursor is.
// preview: shows the pictures, tables and maths laid out beside the box (below it on narrow screens) as you type.
export default function ImageTextarea({ value, onChange, style, placeholder, autoFocus, id, label, preview = false }) {
  const ref = useRef(null)
  const fileRef = useRef(null)
  const [busy, setBusy] = useState(0)
  const [err, setErr] = useState('')

  async function add(files) {
    const list = [...files].filter((f) => f.type.startsWith('image/'))
    if (!list.length) return
    setErr('')
    setBusy((n) => n + list.length)
    const el = ref.current
    let at = el ? el.selectionStart : value.length
    let text = value
    for (const f of list) {
      try {
        const url = await uploadImage(f)
        const before = text.slice(0, at)
        const line = `${before && !before.endsWith('\n') ? '\n' : ''}![](${url})\n`
        text = before + line + text.slice(at)
        at += line.length
        onChange(text)
      } catch (e) {
        setErr(e.message)
      } finally {
        setBusy((n) => n - 1)
      }
    }
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(at, at) } })
  }

  const showPreview = preview && (hasRich(value) || hasMath(value))
  const box = (
    <div className="imgarea">
      <textarea
        ref={ref}
        id={id}
        aria-label={label}
        className="textarea"
        style={style}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onPaste={(e) => { const f = [...(e.clipboardData?.files || [])]; if (f.some((x) => x.type.startsWith('image/'))) { e.preventDefault(); add(f) } }}
        onDragOver={(e) => { if ([...(e.dataTransfer?.items || [])].some((x) => x.kind === 'file')) e.preventDefault() }}
        onDrop={(e) => { const f = [...(e.dataTransfer?.files || [])]; if (f.length) { e.preventDefault(); add(f) } }}
      />
      <div className="row" style={{ gap: 12, marginTop: 6 }}>
        <button type="button" className="link" onClick={() => fileRef.current?.click()} disabled={busy > 0}>{busy ? 'Uploading picture' : 'Add image'}</button>
        <span className="muted small">or paste a screenshot, or drop a file here.</span>
        <input ref={fileRef} type="file" accept={TYPES.join(',')} multiple hidden onChange={(e) => { add(e.target.files); e.target.value = '' }} />
      </div>
      {err && <p className="error small" role="alert">{err}</p>}
    </div>
  )
  // the box stays the first child either way, so turning the preview on never resets the cursor
  return (
    <div className={showPreview ? 'withprev' : undefined}>
      {box}
      {showPreview && (
        <div className="livepreview" aria-label="Preview">
          <p className="muted small">Preview</p>
          <RichText style={{ whiteSpace: 'pre-wrap' }} text={value} />
        </div>
      )}
    </div>
  )
}
