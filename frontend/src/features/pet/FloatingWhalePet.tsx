import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { usePetActivityState } from './usePetActivity'
import {
  ACTIVITY_LABELS,
  ANIMATION_BY_ACTIVITY,
  PET_CELL,
  PET_COLUMNS,
  PET_ROWS,
  PET_TRACKS,
  frameOffset,
} from './whalePetAnimation'
import './whalePet.css'

const PET_SCALE = 0.72
const PET_WIDTH = PET_CELL.width * PET_SCALE
const PET_HEIGHT = PET_CELL.height * PET_SCALE
const STORAGE_KEY = 'insect-workbench:whale-pet-position'

interface PetPosition {
  right: number
  bottom: number
}

function readPosition(): PetPosition {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '') as Partial<PetPosition>
    if (Number.isFinite(value.right) && Number.isFinite(value.bottom)) {
      return { right: Number(value.right), bottom: Number(value.bottom) }
    }
  } catch {
    // Ignore invalid local preferences.
  }
  return { right: 28, bottom: 24 }
}

export default function FloatingWhalePet({ safeRight = 28 }: { safeRight?: number }) {
  const activity = usePetActivityState()
  const animation = ANIMATION_BY_ACTIVITY[activity]
  const track = PET_TRACKS[animation]
  const [frame, setFrame] = useState(0)
  const [position, setPosition] = useState<PetPosition>(readPosition)
  const [bubbleOpen, setBubbleOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth)
  const petRef = useRef<HTMLDivElement>(null)
  const latestPositionRef = useRef(position)
  const pendingPositionRef = useRef<PetPosition | null>(null)
  const animationFrameRef = useRef(0)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    right: number
    bottom: number
    moved: boolean
  } | null>(null)

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      window.cancelAnimationFrame(animationFrameRef.current)
    }
  }, [])

  useEffect(() => {
    setFrame(0)
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    let active = true
    let index = 0
    let timer = 0
    const advance = () => {
      timer = window.setTimeout(() => {
        if (!active) return
        index = (index + 1) % track.frames
        setFrame(index)
        advance()
      }, track.durations[index] ?? 400)
    }
    advance()
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [animation, track])

  useEffect(() => {
    if (activity === 'idle') return
    setBubbleOpen(true)
    const timer = window.setTimeout(() => setBubbleOpen(false), activity === 'error' ? 5200 : 3200)
    return () => window.clearTimeout(timer)
  }, [activity])

  const maximumRight = Math.max(12, viewportWidth - PET_WIDTH - 12)
  const effectiveSafeRight = viewportWidth < 1024 ? 20 : Math.min(safeRight, maximumRight)
  const renderedPosition = useMemo(() => ({
    right: Math.max(Math.min(position.right, maximumRight), effectiveSafeRight),
    bottom: position.bottom,
  }), [effectiveSafeRight, maximumRight, position])
  const petStyle = {
    right: 0,
    bottom: 0,
    translate: `${-renderedPosition.right}px ${-renderedPosition.bottom}px`,
  } satisfies CSSProperties
  const offset = frameOffset(animation, frame, PET_SCALE)
  const spriteStyle = {
    width: PET_WIDTH,
    height: PET_HEIGHT,
    backgroundImage: "url('/pet/whale-girl/spritesheet.webp')",
    backgroundSize: `${PET_COLUMNS * PET_CELL.width * PET_SCALE}px ${PET_ROWS * PET_CELL.height * PET_SCALE}px`,
    backgroundPosition: `${offset.x}px ${offset.y}px`,
  } satisfies CSSProperties

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      right: renderedPosition.right,
      bottom: renderedPosition.bottom,
      moved: false,
    }
    setDragging(true)
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true
    const nextPosition = {
      right: Math.max(effectiveSafeRight, Math.min(maximumRight, drag.right - dx)),
      bottom: Math.max(12, Math.min(window.innerHeight - PET_HEIGHT - 12, drag.bottom - dy)),
    }
    latestPositionRef.current = nextPosition
    pendingPositionRef.current = nextPosition
    if (animationFrameRef.current) return
    animationFrameRef.current = window.requestAnimationFrame(() => {
      animationFrameRef.current = 0
      const pendingPosition = pendingPositionRef.current
      const pet = petRef.current
      if (!pendingPosition || !pet || !dragRef.current) return
      pet.style.translate = `${-pendingPosition.right}px ${-pendingPosition.bottom}px`
    })
  }

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>, toggleBubble: boolean) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    window.cancelAnimationFrame(animationFrameRef.current)
    animationFrameRef.current = 0
    pendingPositionRef.current = null
    const finalPosition = latestPositionRef.current
    if (petRef.current) {
      petRef.current.style.translate = `${-finalPosition.right}px ${-finalPosition.bottom}px`
    }
    dragRef.current = null
    setDragging(false)
    setPosition(finalPosition)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(finalPosition))
    if (toggleBubble && !drag.moved) setBubbleOpen((open) => !open)
  }

  return createPortal(
    <div
      ref={petRef}
      className={`whale-pet whale-pet--${activity}${dragging ? ' whale-pet--dragging' : ''}`}
      style={petStyle}
      data-testid="floating-whale-pet"
    >
      {bubbleOpen ? (
        <div className="whale-pet__bubble" role="status">
          <span className="whale-pet__bubble-dot" />
          {ACTIVITY_LABELS[activity]}
        </div>
      ) : null}
      <div
        role="button"
        tabIndex={0}
        aria-label={`鲸鱼娘：${ACTIVITY_LABELS[activity]}`}
        className="whale-pet__sprite"
        style={spriteStyle}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => finishDrag(event, true)}
        onPointerCancel={(event) => finishDrag(event, false)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setBubbleOpen((open) => !open)
          }
        }}
      />
      <span className="whale-pet__shadow" aria-hidden="true" />
    </div>,
    document.body,
  )
}
