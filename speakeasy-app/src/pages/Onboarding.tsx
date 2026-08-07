import { useState, useEffect } from 'react'
import { useAppStore, CEFRLevel } from '../store/useAppStore'

const cefrLevels = [
  { id: 0 as const, label: 'A0-A1 新手', desc: '刚开始学' },
  { id: 1 as const, label: 'A2-B1 初级', desc: '能简单对话' },
  { id: 2 as const, label: 'B2-C1 进阶', desc: '流利沟通' },
  { id: 3 as const, label: 'C2 精通', desc: '接近母语' },
]
const levelMap: CEFRLevel[] = ['A0-A1', 'A2-B1', 'B2-C1', 'C2']

export default function Onboarding() {
  const { userName, login, logout, setPage } = useAppStore()
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [level, setLevel] = useState(0)

  useEffect(() => {
    const saved = localStorage.getItem('speakeasyUserName')
    if (saved) setName(saved)
  }, [])

  const handleNext = () => {
    if (step === 0 && name.trim()) {
      localStorage.setItem('speakeasyUserName', name.trim())
      setStep(1)
    } else if (step === 1) {
      login(name.trim(), levelMap[level])
    }
  }

  const handleLogout = () => {
    localStorage.removeItem('speakeasyUserName')
    logout()
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-500 to-indigo-600 flex flex-col items-center justify-center px-6">
      <div className="bg-white rounded-3xl w-full max-w-sm p-8 shadow-2xl">
        {step === 0 && (
          <div className="animate-fade-in text-center space-y-5">
            <div className="text-5xl mb-2">🗣️</div>
            <h2 className="text-2xl font-bold text-gray-800">欢迎来到 SpeakEasy</h2>
            <p className="text-sm text-gray-500">AI 英语口语教练</p>
            <input
              autoFocus value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && name.trim() && handleNext()}
              placeholder="请输入你的昵称"
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-center text-lg outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 transition-all"
            />
            {userName && !name && (
              <p className="text-xs text-gray-400">
                上次登录用户为「<span className="font-medium text-gray-600">{userName}</span>」
                <button onClick={() => { setName(userName) }} className="text-blue-500 underline ml-1">点击恢复</button>
              </p>
            )}
            <button disabled={!name.trim()} onClick={handleNext}
              className="w-full py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-all">确认 →</button>
            {userName && (
              <button onClick={handleLogout} className="text-xs text-gray-400 hover:text-red-400 underline">切换账号（清除本机数据）</button>
            )}
          </div>
        )}
        {step === 1 && (
          <div className="animate-fade-in text-center space-y-5">
            <h2 className="text-xl font-bold text-gray-800">你的英语水平?</h2>
            <p className="text-sm text-gray-500">CEFR 欧洲语言标准</p>
            <div className="space-y-2">
              {cefrLevels.map((l) => (
                <button key={l.id} onClick={() => setLevel(l.id)}
                  className={`w-full py-3 px-4 rounded-xl text-left flex justify-between items-center transition-all ${
                    level === l.id ? 'bg-blue-600 text-white shadow-lg' : 'bg-gray-50 text-gray-700 hover:bg-gray-100'
                  }`}>
                  <span className="font-medium">{l.label}</span>
                  <span className="text-xs opacity-70">{l.desc}</span>
                </button>
              ))}
            </div>
            <button onClick={handleNext}
              className="w-full py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-all">开始练习 →</button>
          </div>
        )}
      </div>
      <p className="text-white/60 text-xs mt-6">Let's speak English! 🎤</p>
    </div>
  )
}
