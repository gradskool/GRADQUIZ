import { Routes, Route, Navigate } from 'react-router-dom'
import { ToastProvider } from './components/Toast.jsx'
import Home from './pages/Home.jsx'
import StudentQuiz from './pages/StudentQuiz.jsx'
import AdminGate from './pages/admin/AdminGate.jsx'
import Dashboard from './pages/admin/Dashboard.jsx'
import QuizEditor from './pages/admin/QuizEditor.jsx'
import Results from './pages/admin/Results.jsx'
import { configured } from './lib/supabase.js'

function Missing() {
  return (
    <div className="page narrow stack">
      <h1>Setup needed</h1>
      <p>Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your Netlify environment settings, then redeploy.</p>
    </div>
  )
}

export default function App() {
  if (!configured) return <Missing />
  return (
    <ToastProvider>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/q/:code" element={<StudentQuiz />} />
        <Route path="/admin" element={<AdminGate />}>
          <Route index element={<Dashboard />} />
          <Route path="quiz/:id" element={<QuizEditor />} />
          <Route path="quiz/:id/results" element={<Results />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ToastProvider>
  )
}
