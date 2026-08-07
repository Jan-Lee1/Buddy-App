import { useAppStore } from './store/useAppStore'
import Onboarding from './pages/Onboarding'
import Home from './pages/Home'
import ScenarioPractice from './pages/ScenarioPractice'
import TopicDesign from './pages/TopicDesign'
import ReviewTracking from './pages/ReviewTracking'
import { useEffect } from 'react'

export default function App() {
  const currentPage = useAppStore((s) => s.currentPage)
  const isLoggedIn = useAppStore((s) => s.isLoggedIn)
  const setPage = useAppStore((s) => s.setPage)
  const checkDailyReset = useAppStore((s) => s.checkDailyReset)

  // 恢复会话后自动进入首页
  useEffect(() => {
    if (isLoggedIn) {
      checkDailyReset()
      setPage('home')
    }
  }, []) // 只在首次挂载时触发

  const renderPage = () => {
    switch (currentPage) {
      case 'onboarding':
        return <Onboarding />
      case 'home':
        return <Home />
      case 'scenario':
        return <ScenarioPractice />
      case 'topic':
        return <TopicDesign />
      case 'review':
        return <ReviewTracking />
      default:
        return isLoggedIn ? <Home /> : <Onboarding />
    }
  }

  return (
    <div className="app-container relative bg-white">
      {renderPage()}
    </div>
  )
}
