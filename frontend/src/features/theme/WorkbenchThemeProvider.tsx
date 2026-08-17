import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  getNextWorkbenchTheme,
  getThemeRevealRadius,
  loadWorkbenchTheme,
  saveWorkbenchTheme,
  type ThemeTransitionOrigin,
  type WorkbenchTheme,
} from './workbenchTheme'
import {
  WorkbenchThemeContext,
  type WorkbenchThemeContextValue,
} from './workbenchThemeContext'

const FALLBACK_DURATION_MS = 460

function getStorage(): Storage | undefined {
  return typeof window === 'undefined' ? undefined : window.localStorage
}

function resetTransitionStyles(root: HTMLElement) {
  root.classList.remove('workbench-theme-transitioning', 'workbench-theme-fallback')
  root.style.removeProperty('--theme-transition-x')
  root.style.removeProperty('--theme-transition-y')
  root.style.removeProperty('--theme-transition-radius')
}

export function WorkbenchThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<WorkbenchTheme>(() => (
    loadWorkbenchTheme(getStorage())
  ))
  const [transitioning, setTransitioning] = useState(false)
  const activeRef = useRef(true)
  const transitioningRef = useRef(false)
  const fallbackTimerRef = useRef<number | null>(null)
  const themeRef = useRef(theme)
  themeRef.current = theme

  useLayoutEffect(() => {
    document.documentElement.dataset.workbenchTheme = theme
  }, [theme])

  useEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
      if (fallbackTimerRef.current !== null) {
        window.clearTimeout(fallbackTimerRef.current)
      }
      delete document.documentElement.dataset.workbenchTheme
      resetTransitionStyles(document.documentElement)
    }
  }, [])

  const finishTransition = useCallback(() => {
    if (!activeRef.current) return
    transitioningRef.current = false
    setTransitioning(false)
    resetTransitionStyles(document.documentElement)
  }, [])

  const commitTheme = useCallback((nextTheme: WorkbenchTheme) => {
    if (!activeRef.current) return
    document.documentElement.dataset.workbenchTheme = nextTheme
    saveWorkbenchTheme(getStorage(), nextTheme)
    themeRef.current = nextTheme
    setTheme(nextTheme)
  }, [])

  const toggleTheme = useCallback((origin: ThemeTransitionOrigin) => {
    if (transitioningRef.current) return

    const nextTheme = getNextWorkbenchTheme(themeRef.current)
    const root = document.documentElement
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const startViewTransition = document.startViewTransition?.bind(document)

    if (reducedMotion) {
      commitTheme(nextTheme)
      return
    }

    transitioningRef.current = true
    setTransitioning(true)

    if (startViewTransition) {
      const radius = getThemeRevealRadius(origin, window.innerWidth, window.innerHeight)
      root.style.setProperty('--theme-transition-x', `${origin.x}px`)
      root.style.setProperty('--theme-transition-y', `${origin.y}px`)
      root.style.setProperty('--theme-transition-radius', `${radius}px`)
      root.classList.add('workbench-theme-transitioning')

      try {
        const transition = startViewTransition(() => {
          commitTheme(nextTheme)
        })
        void transition.finished.catch(() => undefined).finally(finishTransition)
        return
      } catch {
        resetTransitionStyles(root)
      }
    }

    root.classList.add('workbench-theme-fallback')
    root.getBoundingClientRect()
    commitTheme(nextTheme)
    fallbackTimerRef.current = window.setTimeout(finishTransition, FALLBACK_DURATION_MS)
  }, [commitTheme, finishTransition])

  const value = useMemo<WorkbenchThemeContextValue>(() => ({
    theme,
    transitioning,
    toggleTheme,
  }), [theme, toggleTheme, transitioning])

  return (
    <WorkbenchThemeContext.Provider value={value}>
      {children}
    </WorkbenchThemeContext.Provider>
  )
}
