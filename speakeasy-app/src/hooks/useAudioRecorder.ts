import { useRef, useState, useCallback } from 'react'

export type RecorderState = 'idle' | 'requesting' | 'ready' | 'recording' | 'stopped' | 'error'

export interface RecorderResult {
  blob: Blob
  durationMs: number
  mimeType: string
  /** Peak volume level 0–1 during the whole recording */
  maxAudioLevel: number
  /** Whether the entire recording was below the silence threshold */
  isSilent: boolean
}

interface UseAudioRecorderOptions {
  maxDuration?: number
  onMaxDuration?: (result: RecorderResult) => void
  onStop?: (result: RecorderResult) => void
  /** Volume level 0–1 below which audio is considered silent. Default 0.03 */
  silenceThreshold?: number
}

export function useAudioRecorder(options: UseAudioRecorderOptions = {}) {
  const { maxDuration = 12000, onMaxDuration, onStop, silenceThreshold = 0.03 } = options

  const [state, setState] = useState<RecorderState>('idle')
  const [errorMessage, setErrorMessage] = useState<string>('')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null)

  // ── MediaRecorder refs ──
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startTimeRef = useRef<number>(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Web Audio API refs ──
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const levelHistoryRef = useRef<number[]>([])
  const animFrameRef = useRef<number>(0)

  // ── Revoke playback URL ──
  const revokePlayback = useCallback(() => {
    if (playbackUrl) {
      URL.revokeObjectURL(playbackUrl)
      setPlaybackUrl(null)
    }
  }, [playbackUrl])

  // ── Stop audio analysis loop ──
  const stopAudioAnalysis = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current)
      animFrameRef.current = 0
    }
  }, [])

  // ── Full cleanup ──
  const cleanup = useCallback(() => {
    // Timers
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    if (maxTimerRef.current) { clearTimeout(maxTimerRef.current); maxTimerRef.current = null }

    // Playback URL
    revokePlayback()

    // Audio analysis
    stopAudioAnalysis()

    // Disconnect source node
    if (sourceNodeRef.current) {
      try { sourceNodeRef.current.disconnect() } catch { /* already disconnected */ }
      sourceNodeRef.current = null
    }

    // Close AudioContext – releases system audio resources
    if (audioCtxRef.current) {
      // resume() may be needed before close() if suspended
      audioCtxRef.current.close().catch(() => {})
      audioCtxRef.current = null
    }
    analyserRef.current = null
    levelHistoryRef.current = []

    // Stop media tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }

    // Stop MediaRecorder if still recording
    if (mediaRecorderRef.current) {
      if (mediaRecorderRef.current.state === 'recording') mediaRecorderRef.current.stop()
      mediaRecorderRef.current = null
    }
  }, [revokePlayback, stopAudioAnalysis])

  // ── Build a RecorderResult from current state ──
  const buildResult = useCallback((mime: string): RecorderResult => {
    const blob = new Blob(chunksRef.current, { type: mime })
    const duration = Date.now() - startTimeRef.current
    const levels = levelHistoryRef.current
    const maxLevel = levels.length > 0 ? Math.max(...levels) : 0
    return { blob, durationMs: duration, mimeType: mime, maxAudioLevel: maxLevel, isSilent: maxLevel < silenceThreshold }
  }, [silenceThreshold])

  // ── Set up AudioContext + AnalyserNode + rAF loop ──
  const setupAudioAnalysis = useCallback((stream: MediaStream) => {
    const ctx = new AudioContext()
    audioCtxRef.current = ctx

    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256          // 128 frequency bins — good balance of performance vs resolution
    analyser.smoothingTimeConstant = 0.5
    analyserRef.current = analyser

    const source = ctx.createMediaStreamSource(stream)
    source.connect(analyser)
    // NOT connected to ctx.destination — avoids feedback/echo
    sourceNodeRef.current = source

    levelHistoryRef.current = []

    const bins = analyser.frequencyBinCount
    const data = new Uint8Array(bins)

    const loop = () => {
      if (!analyserRef.current) return
      analyserRef.current.getByteFrequencyData(data)

      // Compute RMS-normalised level 0–1
      let sum = 0
      for (let i = 0; i < bins; i++) sum += data[i] * data[i]
      const rms = Math.sqrt(sum / bins) / 255
      levelHistoryRef.current.push(rms)

      animFrameRef.current = requestAnimationFrame(loop)
    }
    loop()
  }, [])

  // ── Determine best supported MIME type ──
  const getMimeType = useCallback((): string => {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
    ]
    for (const m of candidates) {
      if (MediaRecorder.isTypeSupported(m)) return m
    }
    return '' // let browser pick default
  }, [])

  // ── Start recording ──
  const startRecording = useCallback(async () => {
    cleanup()
    chunksRef.current = []
    setErrorMessage('')
    setState('requesting')

    // Environment checks
    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorMessage('当前浏览器不支持录音功能，请使用 Chrome、Edge 或 Firefox 浏览器')
      setState('error')
      return
    }
    if (!window.isSecureContext) {
      setErrorMessage('录音需要 HTTPS 安全连接，请使用 HTTPS 访问本页面')
      setState('error')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      setState('ready')

      // ── Kick off Web Audio analysis ──
      setupAudioAnalysis(stream)

      // ── Create MediaRecorder ──
      const mimeType = getMimeType()
      const recorderOpts = mimeType ? { mimeType } : {}
      const recorder = new MediaRecorder(stream, recorderOpts)
      const actualMime = recorder.mimeType || 'audio/webm'
      mediaRecorderRef.current = recorder

      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data?.size > 0) chunksRef.current.push(e.data)
      }

      recorder.onstop = () => {
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
        stopAudioAnalysis()
        setElapsedMs(Date.now() - startTimeRef.current)
        setState('stopped')

        const result = buildResult(actualMime)

        // Generate playback URL
        if (result.blob.size > 0) {
          const url = URL.createObjectURL(result.blob)
          setPlaybackUrl(url)
        }

        onStop?.(result)

        // Release stream
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => t.stop())
          streamRef.current = null
        }
      }

      recorder.onerror = () => {
        setErrorMessage('录音过程中发生错误，请重试')
        setState('error')
        stopAudioAnalysis()
        cleanup()
      }

      // ── Start immediately, 100ms data slices ──
      recorder.start(100)
      startTimeRef.current = Date.now()
      setState('recording')
      setElapsedMs(0)

      // Elapsed timer
      timerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - startTimeRef.current)
      }, 100)

      // Max-duration guard
      if (maxDuration > 0) {
        maxTimerRef.current = setTimeout(() => {
          if (mediaRecorderRef.current?.state === 'recording') {
            mediaRecorderRef.current.stop()
            stopAudioAnalysis()
            const result = buildResult(actualMime)
            onMaxDuration?.(result)
          }
        }, maxDuration)
      }
    } catch (err: unknown) {
      const error = err as DOMException
      const name = error?.name || ''
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError')
        setErrorMessage('麦克风权限被拒绝，请在浏览器设置中允许访问麦克风')
      else if (name === 'NotFoundError' || name === 'DevicesNotFoundError')
        setErrorMessage('未检测到麦克风设备，请确认麦克风已正确连接')
      else if (name === 'NotReadableError')
        setErrorMessage('麦克风被其他应用占用，请关闭其他录音程序后重试')
      else
        setErrorMessage(`麦克风访问失败: ${error?.message || '未知错误'}`)
      setState('error')
      stopAudioAnalysis()
      cleanup()
    }
  }, [cleanup, maxDuration, onMaxDuration, onStop, setupAudioAnalysis, getMimeType, buildResult, stopAudioAnalysis])

  // ── Stop recording ──
  const stopRecording = useCallback(() => {
    if (maxTimerRef.current) { clearTimeout(maxTimerRef.current); maxTimerRef.current = null }
    if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop()
  }, [])

  // ── Cancel / reset to idle ──
  const cancelRecording = useCallback(() => {
    cleanup()
    chunksRef.current = []
    setErrorMessage('')
    setElapsedMs(0)
    setState('idle')
  }, [cleanup])

  // ── Validate a recording result ──
  const validateRecording = useCallback((result: RecorderResult): string | null => {
    if (!result.blob || result.blob.size === 0) return '未检测到有效语音，请重新朗读'
    if (result.durationMs < 1000) return '未检测到有效语音，请重新朗读'
    if (result.isSilent) return '未检测到有效语音，请重新朗读'
    return null
  }, [])

  // ── Get the analyser node for canvas visualisation ──
  const getAnalyser = useCallback((): AnalyserNode | null => analyserRef.current, [])

  return {
    state, elapsedMs, errorMessage, playbackUrl,
    startRecording, stopRecording, cancelRecording, validateRecording, getAnalyser,
    isRecording: state === 'recording',
    isReady: state === 'ready',
    isError: state === 'error',
    canStart: state === 'idle' || state === 'error' || state === 'stopped',
  }
}
