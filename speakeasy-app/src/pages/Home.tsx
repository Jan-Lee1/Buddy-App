import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { scenarios as allScenarios } from '../data/scenarios'
import BottomNav from '../components/BottomNav'

const todayDate = () => new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })

export default function Home() {
  const { userName, streak, todayGoal, todayMinutes, selectScenario, setPage, logout } = useAppStore()
  const [showMenu, setShowMenu] = useState(false)
  const hasHistory = streak > 0 || todayMinutes > 0

  const startScenario = (id: string) => {
    const s = allScenarios.find(e => e.id === id)
    if (s) selectScenario(s)
  }

  const handleSwitchAccount = () => {
    localStorage.removeItem('speakeasyUserName')
    logout()
  }

  const shortScenarios = allScenarios.slice(0, 6)

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col pb-20">
      <div className="bg-white pt-14 pb-5 px-5 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center text-2xl">😊</div>
            <div>
              <p className="text-xl font-bold text-gray-800">欢迎回来，{userName || '同学'}</p>
              <p className="text-xs text-gray-400">{todayDate()}</p>
            </div>
          </div>
          <div className="relative">
            <button onClick={() => setShowMenu(!showMenu)}
              className="w-9 h-9 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center text-sm">⋮</button>
            {showMenu && (
              <div className="absolute right-0 top-10 bg-white rounded-xl shadow-lg border border-gray-100 py-1 z-20 w-36">
                <button onClick={() => { setShowMenu(false); handleSwitchAccount() }}
                  className="w-full px-4 py-2 text-left text-sm text-red-500 hover:bg-red-50">切换账号</button>
              </div>
            )}
          </div>
        </div>
        <div className="mt-5 bg-blue-50 rounded-2xl p-4 flex items-center justify-between">
          <div><p className="text-xs text-blue-600 font-medium">每日目标</p><p className="text-lg font-bold text-blue-700">{todayMinutes}/{todayGoal} 分钟</p></div>
          <div className="w-20 h-20 relative">
            <svg viewBox="0 0 64 64" className="w-full h-full -rotate-90">
              <circle cx="32" cy="32" r="28" fill="none" stroke="#BFDBFE" strokeWidth="5" />
              <circle cx="32" cy="32" r="28" fill="none" stroke="#3B82F6" strokeWidth="5"
                strokeDasharray={`${2 * Math.PI * 28}`} strokeLinecap="round"
                strokeDashoffset={`${2 * Math.PI * 28 * (1 - Math.min(todayMinutes / todayGoal, 1))}`}
                className="transition-all duration-700" />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-sm font-bold text-blue-700">{Math.round((todayMinutes / todayGoal) * 100)}%</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <span>🔥</span>
          <span className="text-sm text-gray-600 font-medium">连续打卡 <span className="text-orange-500 font-bold">{streak}</span> 天</span>
          <span className="text-xs text-gray-400">{streak >= 7 ? '🏆 太厉害了！' : streak >= 3 ? '💪 继续保持！' : '🚀 好的开始！'}</span>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {!hasHistory && (
          <div className="bg-gradient-to-r from-indigo-400 to-purple-400 text-white rounded-2xl p-5 shadow-md">
            <div className="text-3xl mb-2">👋</div>
            <p className="font-bold text-lg">欢迎来到 SpeakEasy！</p>
            <p className="text-sm text-white/90 mt-1">选择下方场景开始第一次练习吧。</p>
          </div>
        )}
        <h3 className="text-sm font-semibold text-gray-700">{hasHistory ? '继续练习' : '开始练习'}</h3>
        <div className="space-y-2">
          {shortScenarios.map(s => (
            <button key={s.id} onClick={() => startScenario(s.id)}
              className="w-full bg-white rounded-2xl p-4 shadow-sm border border-gray-100 flex items-center gap-3 hover:shadow-md transition-all active:scale-[0.98] text-left">
              <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-400 to-indigo-500 flex items-center justify-center text-xl shrink-0">{s.icon}</div>
              <div className="flex-1 min-w-0"><p className="font-semibold text-sm text-gray-800">{s.title}</p><p className="text-xs text-gray-500 truncate">{s.titleZh}</p></div>
              <span className="text-gray-300 text-sm">→</span>
            </button>
          ))}
        </div>
        <h3 className="text-sm font-semibold text-gray-700">快速入口</h3>
        <div className="grid grid-cols-2 gap-3">
          <button onClick={() => setPage('topic')} className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 hover:shadow-md active:scale-[0.98] text-center">
            <div className="text-2xl mb-1">🎲</div><p className="text-sm font-medium text-gray-700">随机话题</p><p className="text-xs text-gray-400">自由陈述练习</p></button>
          <button onClick={() => setPage('review')} className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 hover:shadow-md active:scale-[0.98] text-center">
            <div className="text-2xl mb-1">📊</div><p className="text-sm font-medium text-gray-700">复盘分析</p><p className="text-xs text-gray-400">查看学习趋势</p></button>
        </div>
      </div>
      <BottomNav current="home" />
    </div>
  )
}
