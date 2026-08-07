import { AGENT_PANEL_DEFAULTS } from './panel-layout'

interface PanelResizeHandleProps {
  side: 'left' | 'right'
  currentWidth: number
  maxWidth: number
  active: boolean
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void
  onWidthChange: (width: number) => void
  onReset: () => void
}

export default function PanelResizeHandle({
  side,
  currentWidth,
  maxWidth,
  active,
  onPointerDown,
  onWidthChange,
  onReset,
}: PanelResizeHandleProps) {
  const label = side === 'left' ? '调整左侧导航宽度' : '调整右侧预览宽度'
  const min = side === 'left'
    ? AGENT_PANEL_DEFAULTS.leftMin
    : AGENT_PANEL_DEFAULTS.rightMin
  const max = Math.round(maxWidth)

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    let next: number | null = null
    const step = event.shiftKey ? 40 : 10
    if (event.key === 'Home') next = min
    if (event.key === 'End') next = max
    if (event.key === 'ArrowLeft') {
      next = currentWidth + (side === 'left' ? -step : step)
    }
    if (event.key === 'ArrowRight') {
      next = currentWidth + (side === 'left' ? step : -step)
    }
    if (next === null) return
    event.preventDefault()
    onWidthChange(next)
  }

  return (
    <div
      role="separator"
      aria-label={label}
      aria-controls={side === 'left' ? 'agent-navigation-panel' : 'agent-inspector-panel'}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(currentWidth)}
      tabIndex={0}
      title="拖动调整区域宽度，双击恢复默认布局"
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
      className={`group relative hidden w-2 shrink-0 touch-none cursor-col-resize items-stretch justify-center outline-none xl:flex ${
        active ? 'bg-emerald-50' : 'bg-transparent'
      }`}
    >
      <span className={`w-px transition-colors ${
        active
          ? 'bg-emerald-500'
          : 'bg-slate-200 group-hover:bg-emerald-400 group-focus:bg-emerald-500'
      }`} />
    </div>
  )
}
