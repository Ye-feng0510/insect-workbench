import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

export const AGENT_PANEL_LAYOUT_KEY = 'insect-agent-panel-layout:v1'

export const AGENT_PANEL_DEFAULTS = {
  leftRatio: 240 / (1920 - 16),
  rightRatio: 400 / (1920 - 16),
  leftMin: 200,
  leftMax: 360,
  rightMin: 320,
  rightMax: 640,
  middleMin: 480,
  handleTotal: 16,
  desktopBreakpoint: 1280,
} as const

export interface AgentPanelRatios {
  leftRatio: number
  rightRatio: number
}

export interface AgentPanelWidths {
  left: number
  right: number
}

export interface AgentPanelLayoutController {
  containerRef: React.RefObject<HTMLDivElement | null>
  leftWidth: number
  rightWidth: number
  leftMax: number
  rightMax: number
  draggingSide: 'left' | 'right' | null
  startResize: (
    side: 'left' | 'right',
    event: React.PointerEvent<HTMLElement>,
  ) => void
  setSideWidth: (side: 'left' | 'right', width: number) => void
  reset: () => void
}

const defaultController: AgentPanelLayoutController = {
  containerRef: { current: null },
  leftWidth: 240,
  rightWidth: 400,
  leftMax: AGENT_PANEL_DEFAULTS.leftMax,
  rightMax: AGENT_PANEL_DEFAULTS.rightMax,
  draggingSide: null,
  startResize: () => undefined,
  setSideWidth: () => undefined,
  reset: () => undefined,
}

export const AgentPanelLayoutContext = createContext(defaultController)

export function useAgentPanelLayoutContext(): AgentPanelLayoutController {
  return useContext(AgentPanelLayoutContext)
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function isAgentWorkbenchPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, '') === '/agent-workbench'
}

export function loadAgentPanelRatios(
  storage: Storage | undefined,
): AgentPanelRatios {
  if (!storage) {
    return {
      leftRatio: AGENT_PANEL_DEFAULTS.leftRatio,
      rightRatio: AGENT_PANEL_DEFAULTS.rightRatio,
    }
  }
  try {
    const parsed = JSON.parse(storage.getItem(AGENT_PANEL_LAYOUT_KEY) ?? '')
    if (
      parsed?.version !== 1
      || typeof parsed.leftRatio !== 'number'
      || typeof parsed.rightRatio !== 'number'
      || !Number.isFinite(parsed.leftRatio)
      || !Number.isFinite(parsed.rightRatio)
      || parsed.leftRatio <= 0
      || parsed.rightRatio <= 0
    ) {
      throw new Error('invalid panel layout')
    }
    return {
      leftRatio: parsed.leftRatio,
      rightRatio: parsed.rightRatio,
    }
  } catch {
    return {
      leftRatio: AGENT_PANEL_DEFAULTS.leftRatio,
      rightRatio: AGENT_PANEL_DEFAULTS.rightRatio,
    }
  }
}

export function saveAgentPanelRatios(
  storage: Storage | undefined,
  ratios: AgentPanelRatios,
): void {
  try {
    storage?.setItem(
      AGENT_PANEL_LAYOUT_KEY,
      JSON.stringify({ version: 1, ...ratios }),
    )
  } catch {
    // Persistence is optional when browser storage is restricted.
  }
}

function getBrowserStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

export function calculateAgentPanelWidths(
  ratios: AgentPanelRatios,
  containerWidth: number,
): AgentPanelWidths {
  if (containerWidth < AGENT_PANEL_DEFAULTS.desktopBreakpoint) {
    return { left: 240, right: 400 }
  }
  const available = Math.max(0, containerWidth - AGENT_PANEL_DEFAULTS.handleTotal)
  const sideLimit = Math.max(0, available - AGENT_PANEL_DEFAULTS.middleMin)
  let left = clamp(
    ratios.leftRatio * available,
    AGENT_PANEL_DEFAULTS.leftMin,
    AGENT_PANEL_DEFAULTS.leftMax,
  )
  let right = clamp(
    ratios.rightRatio * available,
    AGENT_PANEL_DEFAULTS.rightMin,
    AGENT_PANEL_DEFAULTS.rightMax,
  )

  const overflow = left + right - sideLimit
  if (overflow > 0) {
    const leftFlex = Math.max(0, left - AGENT_PANEL_DEFAULTS.leftMin)
    const rightFlex = Math.max(0, right - AGENT_PANEL_DEFAULTS.rightMin)
    const flexTotal = leftFlex + rightFlex
    if (flexTotal > 0) {
      left -= overflow * (leftFlex / flexTotal)
      right -= overflow * (rightFlex / flexTotal)
    } else {
      const scale = sideLimit / Math.max(1, left + right)
      left *= scale
      right *= scale
    }
  }
  return {
    left: Math.round(Math.max(0, left)),
    right: Math.round(Math.max(0, right)),
  }
}

export function ratiosFromWidths(
  widths: AgentPanelWidths,
  containerWidth: number,
): AgentPanelRatios {
  const available = Math.max(1, containerWidth - AGENT_PANEL_DEFAULTS.handleTotal)
  return {
    leftRatio: widths.left / available,
    rightRatio: widths.right / available,
  }
}

export function useAgentPanelLayout(): AgentPanelLayoutController {
  const containerRef = useRef<HTMLDivElement>(null)
  const [ratios, setRatios] = useState<AgentPanelRatios>(() => (
    loadAgentPanelRatios(getBrowserStorage())
  ))
  const [containerWidth, setContainerWidth] = useState(
    () => (typeof window === 'undefined' ? 1280 : window.innerWidth),
  )
  const [draggingSide, setDraggingSide] = useState<'left' | 'right' | null>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const element = containerRef.current
    if (!element) return undefined
    const updateWidth = () => setContainerWidth(element.getBoundingClientRect().width)
    updateWidth()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth)
      return () => window.removeEventListener('resize', updateWidth)
    }
    const observer = new ResizeObserver(updateWidth)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => () => {
    dragCleanupRef.current?.()
  }, [])

  const widths = useMemo(
    () => calculateAgentPanelWidths(ratios, containerWidth),
    [containerWidth, ratios],
  )
  const available = Math.max(
    0,
    containerWidth - AGENT_PANEL_DEFAULTS.handleTotal,
  )
  const leftMax = Math.min(
    AGENT_PANEL_DEFAULTS.leftMax,
    available - AGENT_PANEL_DEFAULTS.middleMin - widths.right,
  )
  const rightMax = Math.min(
    AGENT_PANEL_DEFAULTS.rightMax,
    available - AGENT_PANEL_DEFAULTS.middleMin - widths.left,
  )

  const reset = useCallback(() => {
    const defaults = {
      leftRatio: AGENT_PANEL_DEFAULTS.leftRatio,
      rightRatio: AGENT_PANEL_DEFAULTS.rightRatio,
    }
    setRatios(defaults)
    saveAgentPanelRatios(getBrowserStorage(), defaults)
  }, [])

  const setSideWidth = useCallback((
    side: 'left' | 'right',
    width: number,
  ) => {
    const available = Math.max(
      0,
      containerWidth - AGENT_PANEL_DEFAULTS.handleTotal,
    )
    const maxSideWidth = Math.max(
      0,
      available - AGENT_PANEL_DEFAULTS.middleMin,
    )
    const next = { ...widths }
    if (side === 'left') {
      next.left = clamp(
        width,
        AGENT_PANEL_DEFAULTS.leftMin,
        Math.min(AGENT_PANEL_DEFAULTS.leftMax, maxSideWidth - next.right),
      )
    } else {
      next.right = clamp(
        width,
        AGENT_PANEL_DEFAULTS.rightMin,
        Math.min(AGENT_PANEL_DEFAULTS.rightMax, maxSideWidth - next.left),
      )
    }
    const nextRatios = ratiosFromWidths(next, containerWidth)
    setRatios(nextRatios)
    saveAgentPanelRatios(getBrowserStorage(), nextRatios)
  }, [containerWidth, widths])

  const startResize = useCallback((
    side: 'left' | 'right',
    event: React.PointerEvent<HTMLElement>,
  ) => {
    event.preventDefault()
    dragCleanupRef.current?.()
    const startX = event.clientX
    const startWidths = widths
    let latestWidths = startWidths
    const handle = event.currentTarget
    const pointerId = event.pointerId
    handle.setPointerCapture?.(pointerId)
    const initialUserSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    setDraggingSide(side)

    const update = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX
      const available = Math.max(
        0,
        containerWidth - AGENT_PANEL_DEFAULTS.handleTotal,
      )
      const maxSideWidth = Math.max(
        0,
        available - AGENT_PANEL_DEFAULTS.middleMin,
      )
      const next = { ...startWidths }
      if (side === 'left') {
        next.left = clamp(
          startWidths.left + delta,
          AGENT_PANEL_DEFAULTS.leftMin,
          Math.min(AGENT_PANEL_DEFAULTS.leftMax, maxSideWidth - next.right),
        )
      } else {
        next.right = clamp(
          startWidths.right - delta,
          AGENT_PANEL_DEFAULTS.rightMin,
          Math.min(AGENT_PANEL_DEFAULTS.rightMax, maxSideWidth - next.left),
        )
      }
      latestWidths = next
      setRatios(ratiosFromWidths(next, containerWidth))
    }
    const finish = () => {
      window.removeEventListener('pointermove', update)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
      document.body.style.userSelect = initialUserSelect
      setDraggingSide(null)
      if (handle.hasPointerCapture?.(pointerId)) {
        handle.releasePointerCapture(pointerId)
      }
      saveAgentPanelRatios(
        getBrowserStorage(),
        ratiosFromWidths(latestWidths, containerWidth),
      )
      dragCleanupRef.current = null
    }
    window.addEventListener('pointermove', update)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finish)
    dragCleanupRef.current = finish
  }, [containerWidth, widths])

  return {
    containerRef,
    leftWidth: widths.left,
    rightWidth: widths.right,
    leftMax,
    rightMax,
    draggingSide,
    startResize,
    setSideWidth,
    reset,
  }
}
