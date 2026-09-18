import { Link } from 'react-router-dom'

export default function Brand({ to = '/' }) {
  return (
    <Link to={to} className="brand" aria-label="GRADQUIZ home">
      <b>GRADQUIZ</b>
      <span>by GRADSKOOL</span>
    </Link>
  )
}
