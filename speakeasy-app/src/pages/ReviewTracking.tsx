import { useRef, useEffect } from 'react'
import * as echarts from 'echarts'
import { useAppStore } from '../store/useAppStore'
import BottomNav from '../components/BottomNav'

export default function ReviewTracking() {
  const {
    setPage, streak, todayMinutes, todayGoal,
    scoreHistory, dailyRecords, getWeekScoreData,
  } = useAppStore()
  const chartRef = useRef<HTMLDivElement>(null)
  const radarRef = useRef<HTMLDivElement>(null)

  const weekData = getWeekScoreData()
  const hasData = dailyRecords.length > 0
  const todayProgress = Math.min((todayMinutes / todayGoal) * 100, 100)

  // Weekly trend chart
  useEffect(() => {
    if (!chartRef.current) return
    const chart = echarts.init(chartRef.current)
    const option: echarts.EChartsOption = {
      title: { text: '本周口语能力趋势', left: 'center', textStyle: { fontSize: 14, color: '#666', fontWeight: 'normal' } },
      tooltip: { trigger: 'axis' },
      legend: { data: ['综合得分', '流利度'], bottom: 0, textStyle: { fontSize: 11 } },
      grid: { left: '3%', right: '4%', bottom: '12%', top: '18%', containLabel: true },
      xAxis: { type: 'category', boundaryGap: false, data: weekData.map((d) => d.day), axisLine: { lineStyle: { color: '#e5e7eb' } }, axisLabel: { color: '#9ca3af', fontSize: 11 } },
      yAxis: { type: 'value', max: 100, min: 0, splitLine: { lineStyle: { color: '#f3f4f6' } }, axisLabel: { color: '#9ca3af', fontSize: 10 } },
      series: [
        {
          name: '综合得分', type: 'line', data: weekData.map((d) => d.score), smooth: true,
          itemStyle: { color: '#3b82f6' }, lineStyle: { width: 2 }, symbol: 'circle', symbolSize: 6,
          areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(59,130,246,0.3)' }, { offset: 1, color: 'rgba(59,130,246,0.02)' }]) },
        },
        {
          name: '流利度', type: 'line', data: weekData.map((d) => d.fluency), smooth: true,
          itemStyle: { color: '#10b981' }, lineStyle: { width: 2 }, symbol: 'circle', symbolSize: 6,
          areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(16,185,129,0.3)' }, { offset: 1, color: 'rgba(16,185,129,0.02)' }]) },
        },
      ],
    }
    chart.setOption(option)
    const h = () => chart.resize()
    window.addEventListener('resize', h)
    return () => { window.removeEventListener('resize', h); chart.dispose() }
  }, [weekData])

  // Radar
  useEffect(() => {
    if (!radarRef.current) return
    const chart = echarts.init(radarRef.current)
    // Averages from real scores
    const allScores = scoreHistory.length > 0 ? scoreHistory : null
    const avgAccuracy = allScores ? Math.round(allScores.reduce((s, r) => s + r.accuracy, 0) / allScores.length) : 0
    const avgGrammar = avgAccuracy
    const avgFluency = allScores ? Math.round(allScores.reduce((s, r) => s + r.fluency, 0) / allScores.length) : 0
    const avgVocabulary = allScores ? Math.round(allScores.reduce((s, r) => s + r.total, 0) * 0.85 / allScores.length) : 0
    const avgCompleteness = allScores ? Math.round(allScores.reduce((s, r) => s + r.completeness, 0) / allScores.length) : 0

    const option: echarts.EChartsOption = {
      title: { text: '能力雷达图', left: 'center', textStyle: { fontSize: 14, color: '#666', fontWeight: 'normal' } },
      radar: {
        center: ['50%', '55%'], radius: '65%',
        indicator: [
          { name: '发音', max: 100 },
          { name: '语法', max: 100 },
          { name: '流利度', max: 100 },
          { name: '词汇', max: 100 },
          { name: '连贯性', max: 100 },
        ],
        axisName: { color: '#666', fontSize: 11 },
      },
      series: [{
        type: 'radar',
        data: [
          {
            value: allScores ? [avgAccuracy, avgGrammar, avgFluency, avgVocabulary, avgCompleteness] : [0, 0, 0, 0, 0],
            name: '当前水平',
            areaStyle: { color: 'rgba(99,102,241,0.3)' },
            lineStyle: { color: '#6366f1', width: 2 },
            itemStyle: { color: '#6366f1' },
          },
        ],
      }],
      legend: { bottom: 0, textStyle: { fontSize: 11 } },
    }
    chart.setOption(option)
    const h = () => chart.resize()
    window.addEventListener('resize', h)
    return () => { window.removeEventListener('resize', h); chart.dispose() }
  }, [scoreHistory])

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col pb-20">
      <div className="bg-white pt-12 pb-4 px-5 shadow-sm">
        <div className="flex items-center gap-3">
          <button onClick={() => setPage('home')} className="text-gray-500 hover:text-gray-700 text-lg">←</button>
          <h2 className="font-bold text-gray-800">复盘追踪</h2>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {/* No data state */}
        {!hasData && (
          <div className="bg-white rounded-2xl p-10 text-center border border-gray-100 shadow-sm">
            <div className="text-6xl mb-4">📭</div>
            <h3 className="font-bold text-gray-800 mb-2">还没有训练记录</h3>
            <p className="text-sm text-gray-500 mb-6">完成一次情景对话或话题练习后，数据将在这里展示</p>
            <button onClick={() => setPage('home')} className="px-8 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700">
              去练习 →
            </button>
          </div>
        )}

        {hasData && (
          <>
            {/* Today */}
            <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
              <h3 className="font-semibold text-gray-700 mb-3">今日概览</h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-blue-50 rounded-xl p-4 text-center">
                  <div className="text-3xl font-bold text-blue-600">{todayMinutes}<span className="text-lg text-blue-400">min</span></div>
                  <p className="text-xs text-blue-500 mt-1">已完成学习</p>
                </div>
                <div className="bg-orange-50 rounded-xl p-4 text-center">
                  <div className="text-3xl font-bold text-orange-500">{streak}<span className="text-lg text-orange-400">天</span></div>
                  <p className="text-xs text-orange-500 mt-1">连续打卡 🔥</p>
                </div>
              </div>
              <div className="mt-4">
                <div className="flex justify-between text-sm text-gray-600 mb-1">
                  <span>每日目标进度</span><span>{Math.round(todayProgress)}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div className="bg-blue-600 h-2 rounded-full transition-all" style={{ width: `${todayProgress}%` }} />
                </div>
              </div>
            </div>

            {/* Charts */}
            <div className="bg-white rounded-2xl p-3 shadow-sm border border-gray-100">
              <div ref={chartRef} className="w-full h-60" />
            </div>
            <div className="bg-white rounded-2xl p-3 shadow-sm border border-gray-100">
              <div ref={radarRef} className="w-full h-60" />
            </div>

            {/* History */}
            {scoreHistory.length > 0 && (
              <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
                <h3 className="font-semibold text-gray-700 mb-3">最近记录</h3>
                <div className="space-y-2">
                  {scoreHistory.slice(-5).reverse().map((s, i) => (
                    <div key={i} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                      <div>
                        <p className="text-sm font-medium text-gray-700">
                          {s.scenarioTitle || s.topicTitle || '练习'}
                        </p>
                        <p className="text-xs text-gray-400">
                          {new Date(s.timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>
                      <span className="bg-blue-100 text-blue-700 px-3 py-1 rounded-full text-sm font-bold">{s.total}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Streak rewards */}
        <div className="bg-gradient-to-r from-amber-400 to-orange-400 rounded-2xl p-5 shadow-md text-white">
          <h3 className="font-bold mb-3">🏆 打卡激励</h3>
          <div className="flex justify-between">
            <div className="text-center"><div className="text-3xl mb-1">🏅</div><p className="text-xs">连续7天<br />解锁勋章</p></div>
            <div className="text-center"><div className="text-3xl mb-1">🖼️</div><p className="text-xs">壁纸奖励<br />精美主题</p></div>
            <div className="text-center"><div className="text-3xl mb-1">👥</div><p className="text-xs">学习群接龙<br />共同进步</p></div>
          </div>
        </div>

        {/* Tips */}
        <div className="bg-indigo-50 rounded-2xl p-5 border border-indigo-100">
          <h3 className="font-semibold text-indigo-700 mb-2">💡 学习建议</h3>
          <ul className="space-y-2 text-sm text-indigo-600">
            <li>• 每天15分钟口语练习，比每周一次2小时更有效</li>
            <li>• 录音后回放对比，关注发音细节</li>
            <li>• 尝试用英语思考而非先翻译再表达</li>
          </ul>
        </div>
      </div>

      <BottomNav current="review" />
    </div>
  )
}
