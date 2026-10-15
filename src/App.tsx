import { useEffect, useState } from 'react'
import { BoardScreen } from './components/BoardScreen'
import { Dashboard } from './components/Dashboard'
import { readTheme } from './lib/utils'

export default function App() {
  const [path, setPath] = useState(window.location.pathname)
  useEffect(() => {
    document.documentElement.dataset.theme = readTheme()
    const onPop = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const navigate = (to: string) => {
    window.history.pushState({}, '', to)
    setPath(window.location.pathname)
  }
  const boardId = path.match(/^\/b\/([a-z0-9]+)/i)?.[1]
  if (boardId) return <BoardScreen boardId={boardId} navigate={navigate} />
  return <Dashboard navigate={navigate} />
}
