import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type CEFRLevel = 'A0-A1' | 'A2-B1' | 'B2-C1' | 'C2'
export type Page = 'onboarding' | 'home' | 'scenario' | 'topic' | 'review'

export interface Scenario {
  id: string
  title: string
  titleZh: string
  icon: string
  category: string
  level: CEFRLevel
  dialogues: DialogueLine[]
}

export interface DialogueLine {
  role: 'bot' | 'user'
  text: string
}

export interface Topic {
  id: string
  title: string
  titleZh: string
  category: string
  keywords: string[]
  sampleAnswer: string
  level: CEFRLevel
}

export interface ScoreResult {
  accuracy: number
  fluency: number
  completeness: number
  total: number
  errors: string[]
  suggestions: string[]
  timestamp: number
  scenarioTitle?: string
  topicTitle?: string
  transcription?: string
}

export interface DailyRecord {
  date: string       // 'YYYY-MM-DD'
  minutes: number
  score: number
}

interface AppState {
  // ── Persisted ──
  userName: string
  cefrLevel: CEFRLevel | null
  isLoggedIn: boolean
  streak: number
  todayMinutes: number
  todayGoal: number
  lastActiveDate: string          // 'YYYY-MM-DD'
  dailyRecords: DailyRecord[]      // 每日记录
  scoreHistory: ScoreResult[]      // 所有评分历史

  // ── Transient (不持久化) ──
  currentPage: Page
  currentScenario: Scenario | null
  currentDialogueIndex: number
  isRecording: boolean
  scoreResult: ScoreResult | null
  currentTopic: Topic | null
  topicScore: ScoreResult | null

  // ── Actions ──
  setPage: (page: Page) => void
  login: (name: string, level: CEFRLevel) => void
  logout: () => void

  // 每日分钟
  checkDailyReset: () => void
  addDailyPractice: (minutes: number) => void
  addScoreRecord: (score: ScoreResult) => void

  // 打卡
  updateStreakOnLogin: () => void

  // Scenario
  selectScenario: (scenario: Scenario) => void
  nextDialogue: () => void
  setRecording: (recording: boolean) => void
  setScoreResult: (result: ScoreResult | null) => void
  resetScenario: () => void

  // Topic
  selectTopic: (topic: Topic) => void
  setTopicScore: (result: ScoreResult | null) => void
  resetTopic: () => void

  // 复盘用
  getWeekScoreData: () => { day: string; score: number; fluency: number }[]
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // ── Defaults (新用户) ──
      userName: '',
      cefrLevel: null,
      isLoggedIn: false,
      streak: 0,
      todayMinutes: 0,
      todayGoal: 15,
      lastActiveDate: '',
      dailyRecords: [],
      scoreHistory: [],

      currentPage: 'onboarding',
      currentScenario: null,
      currentDialogueIndex: 0,
      isRecording: false,
      scoreResult: null,
      currentTopic: null,
      topicScore: null,

      // ── Navigation ──
      setPage: (page) => set({ currentPage: page }),

      // ── Auth ──
      login: (name, level) => {
        const existingRecords = get().dailyRecords
        const existingScore = get().scoreHistory
        const existingStreak = get().streak

        set({
          userName: name,
          cefrLevel: level,
          isLoggedIn: true,
          currentPage: 'home',
          // 保留历史数据
          dailyRecords: existingRecords,
          scoreHistory: existingScore,
          streak: existingStreak,
        })
        get().checkDailyReset()
        get().updateStreakOnLogin()
      },

      logout: () => set({
        isLoggedIn: false,
        currentPage: 'onboarding',
      }),

      // ── Daily reset ──
      checkDailyReset: () => {
        const today = new Date().toISOString().slice(0, 10)
        const last = get().lastActiveDate
        if (last !== today) {
          set({ todayMinutes: 0, lastActiveDate: today })
        }
      },

      addDailyPractice: (minutes: number) => {
        const today = new Date().toISOString().slice(0, 10)
        const state = get()
        const currentMins = state.lastActiveDate === today ? state.todayMinutes : 0
        const newMins = Math.min(currentMins + minutes, state.todayGoal)

        // 更新 dailyRecords
        const records = [...state.dailyRecords]
        const idx = records.findIndex((r) => r.date === today)
        if (idx >= 0) {
          records[idx] = { ...records[idx], minutes: newMins }
        } else {
          records.push({ date: today, minutes: newMins, score: 0 })
        }

        set({ todayMinutes: newMins, lastActiveDate: today, dailyRecords: records })
      },

      addScoreRecord: (score: ScoreResult) => {
        const today = new Date().toISOString().slice(0, 10)
        const records = [...get().dailyRecords]
        const idx = records.findIndex((r) => r.date === today)
        // 更新当日平均分
        if (idx >= 0) {
          const existing = records[idx]
          const totalScores = get().scoreHistory.filter(
            (s) => new Date(s.timestamp).toISOString().slice(0, 10) === today
          ).length
          const newAvg = Math.round((existing.score * totalScores + score.total) / (totalScores + 1))
          records[idx] = { ...existing, score: newAvg }
        } else {
          // 如果 records 中没有今天（addDailyPractice 未调用），也创建
          records.push({ date: today, minutes: get().todayMinutes, score: score.total })
        }

        set({
          dailyRecords: records,
          scoreHistory: [...get().scoreHistory, score],
        })
      },

      // ── Streak ──
      updateStreakOnLogin: () => {
        const today = new Date().toISOString().slice(0, 10)
        const lastActive = get().lastActiveDate

        if (lastActive === today) {
          return // 今天已经登录过了
        }

        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
        const streak = lastActive === yesterday ? get().streak + 1 : 1

        set({ streak, lastActiveDate: today })
      },

      // ── Scenario ──
      selectScenario: (scenario) => set({
        currentScenario: scenario,
        currentDialogueIndex: 0,
        scoreResult: null,
        currentPage: 'scenario',
      }),
      nextDialogue: () => set((s) => {
        if (!s.currentScenario) return s
        if (s.currentDialogueIndex < s.currentScenario.dialogues.length - 1) {
          return { currentDialogueIndex: s.currentDialogueIndex + 1, scoreResult: null, isRecording: false }
        }
        return s
      }),
      setRecording: (recording) => set({ isRecording: recording }),
      setScoreResult: (result) => set({ scoreResult: result, isRecording: false }),
      resetScenario: () => set({
        currentScenario: null,
        currentDialogueIndex: 0,
        isRecording: false,
        scoreResult: null,
      }),

      // ── Topic ──
      selectTopic: (topic) => set({ currentTopic: topic, topicScore: null, currentPage: 'topic' }),
      setTopicScore: (result) => set({ topicScore: result }),
      resetTopic: () => set({ currentTopic: null, topicScore: null }),

      // ── Get week data (from real records) ──
      getWeekScoreData: () => {
        const records = get().dailyRecords
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
        const todayIdx = new Date().getDay()
        const result: { day: string; score: number; fluency: number }[] = []

        for (let i = 6; i >= 0; i--) {
          const d = new Date()
          d.setDate(d.getDate() - i)
          const dateStr = d.toISOString().slice(0, 10)
          const rec = records.find((r) => r.date === dateStr)
          result.push({
            day: dayNames[(todayIdx - i + 7) % 7],
            score: rec?.score ?? 0,
            fluency: rec ? Math.round((rec.score ?? 0) * 0.9) : 0,
          })
        }
        return result
      },
    }),
    {
      name: 'speakeasy-storage',
      partialize: (state) => ({
        userName: state.userName,
        cefrLevel: state.cefrLevel,
        isLoggedIn: state.isLoggedIn,
        streak: state.streak,
        todayMinutes: state.todayMinutes,
        todayGoal: state.todayGoal,
        lastActiveDate: state.lastActiveDate,
        dailyRecords: state.dailyRecords,
        scoreHistory: state.scoreHistory,
      }),
      merge: (persisted: unknown, current) => ({
        ...current,
        ...(persisted as Partial<AppState>),
      }),
    }
  )
)
