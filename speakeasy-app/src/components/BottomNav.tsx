import { useAppStore, Page } from '../store/useAppStore'

interface Props {
  current: 'home' | 'practice' | 'topic' | 'review'
}

const navItems: { key: Page; label: string; icon: string; currentMap: string[] }[] = [
  { key: 'home', label: 'Home', icon: '🏠', currentMap: ['home'] },
  { key: 'scenario', label: 'Practice', icon: '🎤', currentMap: ['practice', 'scenario'] },
  { key: 'topic', label: 'Topics', icon: '💬', currentMap: ['topic'] },
  { key: 'review', label: 'Stats', icon: '📊', currentMap: ['review'] },
]

export default function BottomNav({ current }: Props) {
  const setPage = useAppStore((s) => s.setPage)

  return (
    <nav className="fixed bottom-0 left-0 right-0 max-w-[430px] mx-auto bg-white border-t border-gray-200 py-2 px-3 flex justify-around items-center z-50">
      {navItems.map((item) => {
        const isActive = item.currentMap.includes(current)
        return (
          <button
            key={item.key}
            onClick={() => setPage(item.key)}
            className={`flex flex-col items-center py-1 px-3 rounded-xl transition-all ${
              isActive ? 'text-blue-600' : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            <span className="text-xl mb-0.5">{item.icon}</span>
            <span className={`text-[10px] font-medium ${isActive ? 'font-semibold' : ''}`}>
              {item.label}
            </span>
            {isActive && <div className="w-1 h-1 rounded-full bg-blue-600 mt-0.5" />}
          </button>
        )
      })}
    </nav>
  )
}
