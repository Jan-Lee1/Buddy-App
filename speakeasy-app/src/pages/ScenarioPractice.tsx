import { useRef, useEffect, useState, useCallback } from 'react'
import { useAppStore, ScoreResult } from '../store/useAppStore'
import { useAudioRecorder, RecorderResult } from '../hooks/useAudioRecorder'
import BottomNav from '../components/BottomNav'

type UIPhase = 'idle' | 'recording' | 'playback' | 'analyzing' | 'result' | 'micError' | 'validationError'

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

    // Resize canvas to match CSS pixel dimensions
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
        // Scale height: minimum 2px so flat line is clearly visible
        const barH = Math.max(2, (value / 255) * H * 0.85)
        const x = (i / bins) * W

        // Colour: red when loud, purple when medium, blue when quiet
        const ratio = value / 255
        const r = Math.round(99 + ratio * 156)
        const g = Math.round(102 - ratio * 50)
        const b = Math.round(241 - ratio * 180)
        ctx.fillStyle = `rgb(${r},${g},${b})`

        // Rounded top corners
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
    <div className="relative w-full h-20 bg-gray-950 rounded-xl overflow-hidden">
      <canvas ref={canvasRef} className="w-full h-full" />
      {silent && isRecording && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-950/60">
          <span className="text-amber-400 text-xs font-medium animate-pulse">等待语音输入...</span>
        </div>
      )}
    </div>
  )
}

/* ───────── API 转写 ───────── */
async function callTranscribeAPI(blob: Blob, mimeType: string): Promise<ScoreResult & { transcription: string }> {
  // Step 1: 创建 ASR 任务
  const res = await fetch('/api/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': mimeType },
    body: blob,
  });
  if (!res.ok) throw new Error('Upload failed: HTTP ' + res.status);
  const { task_id } = await res.json();

  // Step 2: 轮询直到完成（最多 30 次 × 2s = 60s）
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const pollRes = await fetch(`/api/transcribe-status?task_id=${task_id}`);
    const data = await pollRes.json();

    if (data.status === 'completed') {
      return {
        accuracy: data.accuracy ?? 50,
        fluency: data.fluency ?? 50,
        completeness: data.completeness ?? 50,
        total: data.total ?? 50,
        errors: data.errors ?? [],
        suggestions: data.suggestions ?? [],
        timestamp: Date.now(),
        transcription: data.transcription ?? '',
      };
    }
    if (data.status === 'failed' || data.status === 'error') {
      throw new Error(data.message || data.error || 'ASR failed');
    }
  }
  throw new Error('ASR polling timeout');
}

export default function ScenarioPractice() {
  const { currentScenario, currentDialogueIndex, scoreResult, setPage, nextDialogue,
    setRecording, setScoreResult, addDailyPractice, addScoreRecord } = useAppStore()
  const chatEndRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<UIPhase>('idle')
  const [ap, setAP] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [responses, setResponses] = useState<string[]>([])
  const [vMsg, setVMsg] = useState('')
  const [silent, setSilent] = useState(false)
  const lastAudioRef = useRef<RecorderResult | null>(null)

  // ── 音频电平持续监测（用于 UI 场景中的静音提示）──
  const levelCheckRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const onStop = useCallback((r: RecorderResult) => {
    if (levelCheckRef.current) { clearInterval(levelCheckRef.current); levelCheckRef.current = null }
    setSilent(false)
    lastAudioRef.current = r
    const e = recorder.validateRecording(r)
    if (e) { setVMsg(e); setPhase('validationError'); setRecording(false); lastAudioRef.current = null; return }
    setPhase('playback'); setRecording(false)
  }, [setRecording])

  const recorder = useAudioRecorder({ maxDuration: 12000, onStop, silenceThreshold: 0.025 })

  // 录音期间每 300ms 采样一次当前 Analyser 峰值，用于"等待语音输入"覆盖层
  useEffect(() => {
    if (phase === 'recording') {
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

  const submitScore = useCallback(async () => {
    setPhase('analyzing'); setAP(0)
    const d = Math.round(recorder.elapsedMs / 1000)
    const audio = lastAudioRef.current

    // 进度动画
    let p = 0
    timerRef.current = setInterval(() => {
      p += 4
      if (p >= 30) { if (timerRef.current) clearInterval(timerRef.current) }
      setAP(Math.min(95, p))
    }, 120)

    try {
      if (!audio?.blob || audio.blob.size < 1024) throw new Error('No valid recording')

      const scores = await callTranscribeAPI(audio.blob, audio.mimeType)

      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
      setAP(100)

      setResponses(p => [...p, scores.transcription || '(audio transcribed)'])

      const sr: ScoreResult = {
        accuracy: scores.accuracy, fluency: scores.fluency,
        completeness: scores.completeness, total: scores.total,
        errors: scores.errors, suggestions: scores.suggestions,
        timestamp: Date.now(), scenarioTitle: currentScenario?.title || '',
        transcription: scores.transcription,
      }
      setScoreResult(sr); addScoreRecord(sr); addDailyPractice(Math.round(d / 6))
      setPhase('result')
    } catch (e: any) {
      console.error('ASR unavailable, offline fallback:', e.message)
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
      setAP(100)

      const u = currentScenario?.dialogues[currentDialogueIndex]
      if (u?.role === 'user') setResponses(p => [...p, u.text])

      const sr: ScoreResult = {
        accuracy: 0, fluency: 0, completeness: 0, total: 0,
        errors: [`Service offline: ${e.message?.slice(0, 60) || 'unknown error'}`],
        suggestions: ['Start dev API with: npm run dev:api', 'Or deploy to Vercel for full transcription'],
        timestamp: Date.now(), scenarioTitle: currentScenario?.title || '',
      }
      setScoreResult(sr); addScoreRecord(sr); addDailyPractice(Math.round(d / 6))
      setPhase('result')
    }
  }, [recorder.elapsedMs, currentScenario, currentDialogueIndex, setScoreResult, addDailyPractice, addScoreRecord])

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [currentDialogueIndex, scoreResult, phase])
  useEffect(() => { return () => { if (timerRef.current) clearInterval(timerRef.current) } }, [])
  useEffect(() => { setPhase('idle'); setVMsg(''); recorder.cancelRecording(); lastAudioRef.current = null }, [currentDialogueIndex])
  useEffect(() => { if (recorder.isError && phase === 'recording') { setPhase('micError'); setRecording(false) } }, [recorder.isError, recorder.state, phase, setRecording])

  const beginRecord = async () => { setPhase('recording'); setRecording(true); setSilent(false); await recorder.startRecording() }
  const retry = () => { setVMsg(''); recorder.cancelRecording(); setPhase('idle') }

  const fmt = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`

  if (!currentScenario) {
    return (<div className="min-h-screen flex flex-col items-center justify-center pb-20">
      <div className="text-5xl mb-4">🎤</div><p className="text-gray-500">No scenario selected</p>
      <button onClick={() => setPage('home')} className="mt-4 px-6 py-2 bg-blue-600 text-white rounded-xl text-sm">Go Home</button>
      <BottomNav current="practice" /></div>)
  }

  const vis = currentScenario.dialogues.slice(0, currentDialogueIndex + 1)
  const userTurn = (currentDialogueIndex + 1) % 2 === 0
  const done = currentDialogueIndex >= currentScenario.dialogues.length - 1 && phase === 'result'

  return (<div className="min-h-screen flex flex-col bg-white pb-20">
    {/* Header */}
    <div className="bg-white pt-12 pb-3 px-5 shadow-sm z-10 flex items-center gap-3">
      <button onClick={() => setPage('home')} className="text-gray-500 hover:text-gray-700 text-lg">←</button>
      <div className="flex-1"><h2 className="font-bold text-gray-800 text-sm">{currentScenario.title}</h2><p className="text-xs text-gray-500">{currentScenario.titleZh}</p></div>
      <span className="text-xs text-gray-400">{currentDialogueIndex + 1}/{currentScenario.dialogues.length}</span>
    </div>

    {/* Chat */}
    <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
      <div className="flex justify-center"><span className="bg-gray-100 text-gray-400 text-xs px-3 py-1 rounded-full">Scene Start</span></div>
      {vis.map((l, i) => (<div key={i} className={`flex gap-2 animate-fade-in ${l.role === 'user' ? 'flex-row-reverse' : ''}`}>
        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm shrink-0 ${l.role === 'bot' ? 'bg-emerald-100 text-emerald-600' : 'bg-blue-600 text-white'}`}>{l.role === 'bot' ? '🤖' : '😊'}</div>
        <div className={`max-w-[75%] px-4 py-2.5 text-sm leading-relaxed ${l.role === 'bot' ? 'bg-gray-100 text-gray-800 rounded-2xl' : 'bg-blue-600 text-white rounded-2xl'}`}>
          {l.role === 'user' ? (responses[Math.ceil((i + 1) / 2) - 1] || l.text) : l.text}
        </div>
      </div>))}

      {/* ───── 录音中：Canvas 声纹波形 ───── */}
      {phase === 'recording' && (
        <div className="animate-fade-in flex justify-center py-2">
          <div className="bg-gray-50 border border-red-200 rounded-2xl px-4 py-4 w-full">
            <AudioWaveform getAnalyser={recorder.getAnalyser} isRecording={true} silent={silent} />
            <div className="flex items-center justify-between mt-3 px-1">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse" />
                <span className="text-red-500 font-mono text-lg tabular-nums">{fmt(recorder.elapsedMs)}</span>
              </div>
              <span className="text-xs text-gray-400">实时声纹波形</span>
            </div>
            <p className="text-xs text-red-400 mt-2 text-center">正在录音，请朗读对话</p>
          </div>
        </div>
      )}

      {/* ───── 回放确认 ───── */}
      {phase === 'playback' && recorder.playbackUrl && (<div className="animate-fade-in">
        <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-5 text-center space-y-3">
          <div className="text-2xl">✅</div>
          <p className="font-semibold text-emerald-700">录音成功 · 请试听确认</p>
          <p className="text-xs text-emerald-600">时长 {Math.round(recorder.elapsedMs / 1000)}s，点击播放按钮试听</p>
          {/* 无 autoplay，用户手动点击播放 */}
          <audio controls src={recorder.playbackUrl} className="w-full h-9 mt-2" />
          <div className="flex gap-3 pt-1">
            <button onClick={() => { recorder.cancelRecording(); setPhase('idle') }} className="flex-1 py-2.5 bg-gray-100 text-gray-700 rounded-xl text-sm font-medium hover:bg-gray-200 active:scale-[0.98]">重录 🔄</button>
            <button onClick={submitScore} className="flex-1 py-2.5 bg-emerald-500 text-white rounded-xl text-sm font-medium hover:bg-emerald-600 active:scale-[0.98]">确认提交评分 →</button>
          </div>
        </div>
      </div>)}

      {/* ───── 麦克风错误 ───── */}
      {phase === 'micError' && (<div className="animate-fade-in">
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 text-center">
          <div className="text-3xl mb-2">🎙️</div>
          <p className="font-semibold text-amber-700 mb-1">麦克风不可用</p>
          <p className="text-sm text-amber-600 mb-4">{recorder.errorMessage}</p>
          <button onClick={retry} className="w-full py-2.5 bg-amber-500 text-white rounded-xl font-medium hover:bg-amber-600 active:scale-[0.98]">重试</button>
          <p className="text-xs text-amber-400 mt-2">请确认浏览器已允许麦克风权限，且麦克风未被占用</p>
        </div>
      </div>)}

      {/* ───── 静音/无效校验拦截 ───── */}
      {phase === 'validationError' && (<div className="animate-fade-in">
        <div className="bg-orange-50 border border-orange-200 rounded-2xl p-5 text-center">
          <div className="text-3xl mb-2">⚠️</div>
          <p className="font-semibold text-orange-700 mb-1">未检测到有效语音，请重新朗读</p>
          <p className="text-sm text-orange-600 mb-4">{vMsg}</p>
          <button onClick={retry} className="w-full py-2.5 bg-orange-500 text-white rounded-xl font-medium hover:bg-orange-600 active:scale-[0.98]">重新朗读</button>
        </div>
      </div>)}

      {/* ───── AI 评分中 ───── */}
      {phase === 'analyzing' && (<div className="animate-fade-in flex justify-center py-4">
        <div className="bg-indigo-50 border border-indigo-200 rounded-2xl px-6 py-5 w-full">
          <div className="flex items-center justify-center gap-2 mb-3"><div className="text-xl">🔍</div><p className="text-indigo-700 font-medium text-sm">AI 正在分析你的语音...</p></div>
          <div className="w-full bg-indigo-200 rounded-full h-1.5 overflow-hidden"><div className="bg-indigo-600 h-1.5 rounded-full transition-all duration-200 ease-out" style={{ width: `${ap}%` }} /></div>
          <div className="flex justify-between mt-2 text-xs text-indigo-400"><span>声纹识别</span><span>发音评测</span><span>流利度分析</span></div>
        </div>
      </div>)}

      {/* ───── 评分结果 ───── */}
      {phase === 'result' && scoreResult && (<div className="animate-fade-in bg-slate-800 text-white rounded-2xl p-5 space-y-4">
        <h4 className="font-semibold text-sm">评测结果</h4>
        <div className="space-y-2.5">
          {[{ l: '准确度', k: 'accuracy', c: 'bg-blue-400' }, { l: '流利度', k: 'fluency', c: 'bg-green-400' }, { l: '完整度', k: 'completeness', c: 'bg-purple-400' }].map(it => (
            <div key={it.k}><div className="flex justify-between text-xs mb-1"><span>{it.l}</span><span>{(scoreResult as any)[it.k]}%</span></div>
              <div className="w-full bg-gray-600 rounded-full h-1.5"><div className={`${it.c} h-1.5 rounded-full`} style={{ width: `${(scoreResult as any)[it.k]}%` }} /></div></div>))}
        </div>
        <div className="text-center pt-2"><div className="text-4xl font-bold text-yellow-400">{scoreResult.total}</div><div className="text-xs text-gray-400 mt-1">综合得分</div></div>
        {scoreResult.errors.length > 0 && (<div className="bg-slate-700/50 rounded-xl p-3"><p className="text-xs font-medium text-red-400 mb-1">错误识别</p>{scoreResult.errors.map((e, i) => <p key={i} className="text-xs text-gray-300">• {e}</p>)}</div>)}
        {scoreResult.suggestions.length > 0 && (<div className="bg-slate-700/50 rounded-xl p-3"><p className="text-xs font-medium text-emerald-400 mb-1">优化建议</p>{scoreResult.suggestions.map((s, i) => <p key={i} className="text-xs text-gray-300">• {s}</p>)}</div>)}
        {scoreResult.transcription && (<div className="bg-slate-700/50 rounded-xl p-3"><p className="text-xs font-medium text-blue-400 mb-1">转写文本</p><p className="text-xs text-gray-200 leading-relaxed italic">"{scoreResult.transcription}"</p></div>)}
      </div>)}

      {/* ───── 场景完成 ───── */}
      {done && (<div className="text-center py-6 animate-fade-in">
        <div className="text-5xl mb-3">🎉</div><p className="text-gray-800 font-semibold">场景完成!</p>
        <p className="text-gray-500 text-sm">综合得分 {scoreResult?.total} 分</p>
        <button onClick={() => setPage('home')} className="mt-4 px-6 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700">返回首页</button>
      </div>)}
      <div ref={chatEndRef} />
    </div>

    {/* ───── 底部操作栏 ───── */}
    <div className="bg-white border-t border-gray-100 px-5 py-4 pb-8">
      {!userTurn && phase === 'idle' && !done && (<button onClick={nextDialogue} className="w-full py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 active:scale-[0.98]">Continue →</button>)}
      {userTurn && !done && (<div className="flex flex-col items-center gap-3">
        {phase === 'idle' && (<button onClick={beginRecord} className="w-16 h-16 rounded-full bg-red-500 text-white flex items-center justify-center text-2xl shadow-lg shadow-red-200 hover:bg-red-600 active:scale-95 transition-all recording-pulse">🎤</button>)}
        {phase === 'recording' && (<div className="flex items-center gap-4"><button onClick={recorder.stopRecording} className="w-14 h-14 rounded-full bg-red-500 text-white flex items-center justify-center shadow-lg shadow-red-200 active:scale-95"><div className="w-5 h-5 bg-white rounded-sm" /></button><p className="text-xs text-red-500">点击停止</p></div>)}
        {phase === 'playback' && (<p className="text-xs text-emerald-500 py-2">↑ 请确认录音后提交评分</p>)}
        {phase === 'analyzing' && (<button disabled className="w-16 h-16 rounded-full bg-indigo-400 text-white flex items-center justify-center text-lg shadow-lg">🔍</button>)}
        {phase === 'result' && (<button onClick={nextDialogue} className="w-full py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 active:scale-[0.98]">下一句 →</button>)}
        {(phase === 'micError' || phase === 'validationError') && (<button onClick={retry} className="w-16 h-16 rounded-full bg-orange-500 text-white flex items-center justify-center text-2xl shadow-lg hover:bg-orange-600 active:scale-95">🔄</button>)}
        <p className="text-xs text-gray-400">{phase === 'idle' && '点击麦克风开始录音（无需等待）'}{phase === 'recording' && `录音中 ${fmt(recorder.elapsedMs)}...`}{phase === 'playback' && '请确认录音 ↑'}{phase === 'analyzing' && 'AI 评分中...'}{phase === 'result' && '评分完成 ✓'}{phase === 'micError' && '权限异常 ↑'}{phase === 'validationError' && vMsg + ' ↑'}</p>
      </div>)}
      {done && (<div className="text-center"><button onClick={() => setPage('review')} className="w-full py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700">查看复盘分析 →</button></div>)}
    </div>
    <BottomNav current="practice" />
  </div>)
}
