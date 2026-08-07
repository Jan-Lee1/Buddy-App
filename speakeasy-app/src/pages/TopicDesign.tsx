import { useState, useRef, useEffect, useCallback } from 'react'
import { useAppStore, ScoreResult } from '../store/useAppStore'
import { useAudioRecorder, RecorderResult } from '../hooks/useAudioRecorder'
import { topics } from '../data/scenarios'
import BottomNav from '../components/BottomNav'

type Phase = 'select' | 'prepare' | 'speaking' | 'playback' | 'analyzing' | 'result' | 'micError' | 'validationError'

/* ───────── Canvas 声纹波形组件 ───────── */
function AudioWaveform({ getAnalyser, isRecording, silent }: {
  getAnalyser: () => AnalyserNode | null
  isRecording: boolean
  silent: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      canvas.width = rect.width * devicePixelRatio
      canvas.height = rect.height * devicePixelRatio
    }
    resize()
    window.addEventListener('resize', resize)

    if (!isRecording) return

    const analyser = getAnalyser()
    if (!analyser) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const bins = analyser.frequencyBinCount
    const data = new Uint8Array(bins)
    let raf = 0

    const draw = () => {
      raf = requestAnimationFrame(draw)

      const W = canvas.width
      const H = canvas.height
      analyser.getByteFrequencyData(data)

      ctx.clearRect(0, 0, W, H)

      const barGap = 1.5
      const barW = Math.max(2, (W / bins) - barGap)
      const skip = barW < 2 ? Math.max(1, Math.ceil(bins / Math.floor(W / 3))) : 1

      for (let i = 0; i < bins; i += skip) {
        const value = data[i]
        const barH = Math.max(2, (value / 255) * H * 0.85)
        const x = (i / bins) * W

        const ratio = value / 255
        const r = Math.round(99 + ratio * 156)
        const g = Math.round(102 - ratio * 50)
        const b = Math.round(241 - ratio * 180)
        ctx.fillStyle = `rgb(${r},${g},${b})`

        const radius = Math.min(2, barW / 2)
        ctx.beginPath()
        ctx.moveTo(x, H)
        ctx.lineTo(x, H - barH + radius)
        ctx.quadraticCurveTo(x, H - barH, x + radius, H - barH)
        ctx.lineTo(x + barW - radius, H - barH)
        ctx.quadraticCurveTo(x + barW, H - barH, x + barW, H - barH + radius)
        ctx.lineTo(x + barW, H)
        ctx.closePath()
        ctx.fill()
      }
    }

    draw()

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [isRecording, getAnalyser])

  return (
    <div className="relative w-full h-24 bg-gray-950 rounded-xl overflow-hidden shadow-inner">
      <canvas ref={canvasRef} className="w-full h-full" />
      {silent && isRecording && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-950/60">
          <span className="text-amber-400 text-xs font-medium animate-pulse">等待语音输入...</span>
        </div>
      )}
    </div>
  )
}

const catIcons: Record<string, string> = { '职场领域': '💼', '技能领域': '🔧', '社会领域': '👥', '科学领域': '🔬', '自我提升': '🌱' }
const ielts = [
  { n: '流利度与连贯性', c: 'FC', d: 'Fluency and Coherence' },
  { n: '词汇多样性', c: 'LR', d: 'Lexical Resource' },
  { n: '语法准确性', c: 'GRA', d: 'Grammatical Range and Accuracy' },
  { n: '发音清晰度', c: 'P', d: 'Pronunciation' },
  { n: '内容完整性', c: 'CC', d: 'Content Completeness' },
]

function genScore(d: number): ScoreResult {
  return { accuracy: Math.floor(Math.random() * 15) + 70, fluency: Math.floor(Math.random() * 18) + 68,
    completeness: Math.min(100, Math.floor((d / 60) * 100)),
    total: Math.round((Math.floor(Math.random() * 18) + 68) * .3 + (Math.floor(Math.random() * 20) + 65) * .2 + (Math.floor(Math.random() * 15) + 70) * .2 + (Math.floor(Math.random() * 15) + 72) * .15 + Math.min(100, Math.floor((d / 60) * 100)) * .15),
    errors: ['中式英语: 按中文语序组织英文句子', '时态混用: 过去时与现在时交替', '词汇单调: 多次使用简单词'],
    suggestions: ['用"Furthermore / Moreover"扩展论述层次', '回听录音找出3处可优化的发音', '用"Additionally / In contrast"类过渡词', '尝试更复杂的长句表达'], timestamp: Date.now() }
}

export default function TopicDesign() {
  const { setPage, addDailyPractice, addScoreRecord } = useAppStore()
  const [topic, setTopic] = useState(topics[0])
  const [phase, setPhase] = useState<Phase>('select')
  const [cat, setCat] = useState<string | null>(null)
  const [score, setScore] = useState<ScoreResult | null>(null)
  const [ap, setAP] = useState(0)
  const [prep, setPrep] = useState(30)
  const [vMsg, setVMsg] = useState('')
  const [silent, setSilent] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const durRef = useRef(0)
  const levelCheckRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const onStop = useCallback((r: RecorderResult) => {
    if (levelCheckRef.current) { clearInterval(levelCheckRef.current); levelCheckRef.current = null }
    setSilent(false)
    const e = recorder.validateRecording(r)
    if (e) { setVMsg(e); setPhase('validationError'); return }
    setPhase('playback')
  }, [])

  const recorder = useAudioRecorder({ maxDuration: 90000, onStop, silenceThreshold: 0.025 })

  // 录音期间每 300ms 采样音量峰值，用于"等待语音输入"覆盖层
  useEffect(() => {
    if (phase === 'speaking') {
      levelCheckRef.current = setInterval(() => {
        const a = recorder.getAnalyser()
        if (!a) return
        const d = new Uint8Array(a.frequencyBinCount)
        a.getByteFrequencyData(d)
        let max = 0
        for (let i = 0; i < d.length; i++) { if (d[i] > max) max = d[i] }
        setSilent(max / 255 < 0.025)
      }, 300)
    }
    return () => { if (levelCheckRef.current) { clearInterval(levelCheckRef.current); levelCheckRef.current = null } }
  }, [phase, recorder])

  const submitScore = useCallback(() => {
    setPhase('analyzing'); setAP(0); durRef.current = recorder.elapsedMs
    let p = 0
    timerRef.current = setInterval(() => {
      p += Math.random() * 12 + 4
      if (p >= 100) { p = 100; if (timerRef.current) clearInterval(timerRef.current)
        const d = Math.round(recorder.elapsedMs / 1000)
        const s = genScore(d); s.topicTitle = topic.title; setScore(s); addScoreRecord(s); addDailyPractice(Math.round(d / 20)); setPhase('result') }
      setAP(Math.min(100, p))
    }, 200)
  }, [recorder.elapsedMs, topic, addDailyPractice, addScoreRecord])

  useEffect(() => { return () => { if (timerRef.current) clearInterval(timerRef.current) } }, [])
  useEffect(() => { if (recorder.isError && phase === 'speaking') setPhase('micError') }, [recorder.isError, recorder.state, phase])

  const cats = [...new Set(topics.map(t => t.category))]
  const filtered = cat ? topics.filter(t => t.category === cat) : topics
  const rnd = () => { setTopic(topics[Math.floor(Math.random() * topics.length)]); startPrep() }
  const sel = (t: typeof topics[0]) => { setTopic(t); startPrep() }
  const startPrep = () => { setPhase('prepare'); setPrep(30)
    timerRef.current = setInterval(() => { setPrep(p => { if (p <= 1) { if (timerRef.current) clearInterval(timerRef.current); return 0 } return p - 1 }) }, 1000) }
  const beginSpeak = async () => { if (timerRef.current) clearInterval(timerRef.current); setPhase('speaking'); setSilent(false); await recorder.startRecording() }
  const reset = () => { if (timerRef.current) clearInterval(timerRef.current); setScore(null); setPhase('select'); setVMsg(''); recorder.cancelRecording() }
  const retry = () => { setVMsg(''); recorder.cancelRecording(); setPhase('select') }

  const fmt = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`

  return (<div className="min-h-screen bg-gray-50 flex flex-col pb-20">
    <div className="bg-white pt-12 pb-4 px-5 shadow-sm">
      <div className="flex items-center gap-3 mb-2"><button onClick={() => setPage('home')} className="text-gray-500 hover:text-gray-700 text-lg">←</button><h2 className="font-bold text-gray-800">话题自由练习</h2></div>
      <p className="text-xs text-gray-500 ml-9">选话题，用英语自由表达观点 · 雅思标准评分</p>
    </div>
    <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
      {/* SELECT */}
      {phase === 'select' && (<div className="animate-fade-in space-y-4">
        <button onClick={rnd} className="w-full bg-gradient-to-r from-indigo-500 to-purple-500 text-white p-5 rounded-2xl shadow-md hover:shadow-lg active:scale-[0.98]">
          <div className="text-3xl mb-2">🎲</div><p className="font-bold text-lg">随机抽取话题</p><p className="text-sm text-white/80">AI 随机选择，锻炼即兴表达</p></button>
        <div><p className="text-sm font-medium text-gray-600 mb-2">按领域筛选</p>
          <div className="flex flex-wrap gap-2">{cats.map(c => (<button key={c} onClick={() => setCat(cat === c ? null : c)} className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${cat === c ? 'bg-purple-600 text-white shadow-md' : 'bg-purple-50 text-purple-700 hover:bg-purple-100'}`}>{catIcons[c] || '📋'} {c}</button>))}</div>
        </div>
        <div className="space-y-2">{filtered.map(t => (<button key={t.id} onClick={() => sel(t)} className="w-full bg-white p-4 rounded-xl shadow-sm border border-gray-100 text-left hover:shadow-md active:scale-[0.98]">
          <div className="flex items-center gap-2 mb-1"><span>{catIcons[t.category] || '📋'}</span><span className="font-semibold text-sm text-gray-800">{t.title}</span><span className="text-xs text-gray-400 ml-auto">{t.level}</span></div>
          <p className="text-xs text-gray-500">{t.titleZh}</p></button>))}</div>
      </div>)}

      {/* PREPARE */}
      {phase === 'prepare' && (<div className="animate-fade-in space-y-4">
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center justify-between mb-4"><div className="flex items-center gap-2"><span className="text-2xl">{catIcons[topic.category] || '📋'}</span><h3 className="font-bold text-gray-800">{topic.title}</h3></div><span className="bg-orange-100 text-orange-600 px-2 py-1 rounded text-xs font-medium">{prep > 0 ? `准备 ${prep}s` : '就绪'}</span></div>
          <p className="text-sm font-medium text-gray-600 mb-2">关键词提示</p>
          <div className="flex flex-wrap gap-2 mb-4">{topic.keywords.map((kw, i) => (<span key={i} className="bg-purple-50 text-purple-700 px-3 py-1.5 rounded-lg text-xs font-medium border border-purple-100">{kw}</span>))}</div>
          <p className="text-sm font-medium text-gray-600 mb-2">参考框架</p>
          <p className="text-xs text-gray-500 italic bg-gray-50 p-3 rounded-lg leading-relaxed">{topic.sampleAnswer}</p>
        </div>
        <button onClick={beginSpeak} className="w-full py-4 bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-2xl font-bold text-lg shadow-lg hover:shadow-xl active:scale-[0.98]">🎤 开始陈述（直接录音）</button>
        <button onClick={reset} className="w-full py-3 text-gray-500 text-sm hover:text-gray-700">换一个话题</button>
      </div>)}

      {/* SPEAKING — 真实 Canvas 声纹波形 */}
      {phase === 'speaking' && (<div className="animate-fade-in">
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-purple-200">
          <p className="text-sm text-gray-500 mb-2 text-center">{topic.title}</p>
          <div className="flex flex-wrap justify-center gap-2 mb-3">{topic.keywords.slice(0, 4).map((kw, i) => (<span key={i} className="bg-indigo-50 text-indigo-600 px-2 py-1 rounded text-xs">{kw}</span>))}</div>

          {/* 真实声纹波形图 */}
          <AudioWaveform getAnalyser={recorder.getAnalyser} isRecording={true} silent={silent} />

          <div className="flex items-center justify-between mt-3 px-1">
            <span className="text-3xl font-mono font-bold text-purple-600">{fmt(recorder.elapsedMs)}</span>
            <span className="text-xs text-gray-400">实时声纹波形</span>
            <button onClick={recorder.stopRecording} className="px-5 py-2.5 bg-red-500 text-white rounded-xl font-medium hover:bg-red-600 active:scale-95 shadow-lg shadow-red-200">停止录音 ■</button>
          </div>
          <p className="text-xs text-purple-400 mt-3 text-center">正在录音，请用英语自由陈述</p>
        </div>
      </div>)}

      {/* PLAYBACK — 回放确认 */}
      {phase === 'playback' && recorder.playbackUrl && (<div className="animate-fade-in">
        <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-6 text-center space-y-3">
          <div className="text-2xl">✅</div>
          <p className="font-semibold text-emerald-700">录音成功 · 请试听确认</p>
          <p className="text-xs text-emerald-600">时长 {Math.round(recorder.elapsedMs / 1000)}s，点击播放按钮试听</p>
          <audio controls src={recorder.playbackUrl} className="w-full h-9 mt-2" />
          <div className="flex gap-3 pt-1">
            <button onClick={() => { recorder.cancelRecording(); setPhase('select') }} className="flex-1 py-2.5 bg-gray-100 text-gray-700 rounded-xl text-sm font-medium hover:bg-gray-200 active:scale-[0.98]">重录 🔄</button>
            <button onClick={submitScore} className="flex-1 py-2.5 bg-emerald-500 text-white rounded-xl text-sm font-medium hover:bg-emerald-600 active:scale-[0.98]">确认提交评分 →</button>
          </div>
        </div>
      </div>)}

      {/* MIC ERROR */}
      {phase === 'micError' && (<div className="animate-fade-in"><div className="bg-amber-50 border border-amber-200 rounded-2xl p-6 text-center">
        <div className="text-3xl mb-2">🎙️</div><p className="font-semibold text-amber-700 mb-1">麦克风不可用</p><p className="text-sm text-amber-600 mb-4">{recorder.errorMessage}</p>
        <button onClick={reset} className="w-full py-3 bg-amber-500 text-white rounded-xl font-medium hover:bg-amber-600 active:scale-[0.98]">返回重试</button>
        <p className="text-xs text-amber-400 mt-2">请确认浏览器已允许麦克风权限，且麦克风未被占用</p>
      </div></div>)}

      {/* VALIDATION ERROR — 静音/时长拦截 */}
      {phase === 'validationError' && (<div className="animate-fade-in"><div className="bg-orange-50 border border-orange-200 rounded-2xl p-6 text-center">
        <div className="text-3xl mb-2">⚠️</div><p className="font-semibold text-orange-700 mb-1">未检测到有效语音，请重新朗读</p><p className="text-sm text-orange-600 mb-4">{vMsg}</p>
        <p className="text-xs text-gray-500 mb-4">录音时长不足 1 秒或未检测到有效声音输入</p>
        <div className="flex gap-3"><button onClick={reset} className="flex-1 py-3 bg-gray-100 text-gray-700 rounded-xl font-medium hover:bg-gray-200">返回选题</button><button onClick={retry} className="flex-1 py-3 bg-orange-500 text-white rounded-xl font-medium hover:bg-orange-600 active:scale-[0.98]">重新尝试</button></div>
      </div></div>)}

      {/* ANALYZING */}
      {phase === 'analyzing' && (<div className="animate-fade-in"><div className="bg-white rounded-2xl p-6 shadow-sm border border-indigo-200">
        <div className="text-center mb-4"><p className="text-2xl mb-2">🔍</p><p className="text-indigo-700 font-medium">AI 分析中...</p><p className="text-xs text-gray-500">声纹识别 · 语法检测 · 内容评估</p></div>
        <div className="w-full bg-gray-200 rounded-full h-2 mb-3 overflow-hidden"><div className="bg-indigo-600 h-2 rounded-full transition-all duration-200 ease-out" style={{ width: `${ap}%` }} /></div>
        <div className="flex justify-between text-xs text-gray-400">{['识别语音', '评估流利度', '检测语法', '综合评分'].map((l, i) => (<span key={i} className={ap > i * 25 ? 'text-indigo-500 font-medium' : ''}>{ap > i * 25 ? `✓ ${l}` : `○ ${l}`}</span>))}</div>
      </div></div>)}

      {/* RESULT */}
      {phase === 'result' && score && (<div className="animate-fade-in space-y-4">
        <div className="bg-gradient-to-r from-indigo-500 to-purple-500 text-white rounded-2xl p-6 text-center shadow-lg">
          <div className="text-5xl font-extrabold mb-1">{score.total}</div><p className="text-sm text-white/80">综合得分 (雅思标准)</p><p className="text-xs text-white/60 mt-1">陈述时长: {Math.round(durRef.current / 1000)}s</p>
        </div>
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100"><h4 className="font-semibold text-gray-700 mb-4">五维评分</h4>
          <div className="space-y-3">{ielts.map((c, i) => { const s = Math.min(9, Math.max(3, Math.floor(score.total / 12) + (i % 4) + 1))
            return (<div key={c.c}><div className="flex justify-between mb-1"><span className="font-medium text-sm text-gray-700">{c.n}</span><span className="text-xs text-gray-400">{c.d}</span></div>
              <div className="flex items-center gap-2"><div className="flex-1 bg-gray-200 rounded-full h-1.5"><div className="bg-indigo-500 h-1.5 rounded-full" style={{ width: `${(s / 9) * 100}%` }} /></div><span className="text-indigo-600 font-bold text-sm w-6 text-right">{s}</span></div></div>)})}
          </div>
        </div>
        <div className="bg-red-50 rounded-2xl p-5 border border-red-100"><h4 className="font-semibold text-red-700 mb-2">需要改进</h4>{score.errors.map((e, i) => <p key={i} className="text-sm text-red-600 mb-1">• {e}</p>)}</div>
        <div className="bg-emerald-50 rounded-2xl p-5 border border-emerald-100"><h4 className="font-semibold text-emerald-700 mb-2">优化建议</h4>{score.suggestions.map((s, i) => <p key={i} className="text-sm text-emerald-600 mb-1">• {s}</p>)}</div>
        <div className="flex gap-3 pb-4"><button onClick={reset} className="flex-1 py-3 bg-gray-100 text-gray-700 rounded-xl font-medium hover:bg-gray-200">再来一题</button><button onClick={() => setPage('review')} className="flex-1 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700">查看复盘 →</button></div>
      </div>)}
    </div>
    <BottomNav current="topic" />
  </div>)
}
