import type { CSSProperties } from 'react'

export type AiWhaleState = 'idle' | 'recognizing' | 'resolving' | 'success' | 'error'

interface AiWhaleProps {
  state?: AiWhaleState
  compact?: boolean
  className?: string
}

const stateLabels: Record<AiWhaleState, string> = {
  idle: 'AI 鲸鱼待命中',
  recognizing: 'AI 正在读取标本',
  resolving: 'AI 正在核验分类',
  success: 'AI 已完成本轮工作',
  error: 'AI 需要人工复核',
}

export default function AiWhale({
  state = 'idle',
  compact = false,
  className = '',
}: AiWhaleProps) {
  const style = { '--whale-delay': state === 'recognizing' ? '0s' : '1.2s' } as CSSProperties
  return (
    <div
      className={`ai-whale ai-whale--${state} ${compact ? 'ai-whale--compact' : ''} ${className}`}
      style={style}
      role="img"
      aria-label={stateLabels[state]}
    >
      <div className="ai-whale__halo" />
      <svg className="ai-whale__svg" viewBox="0 0 360 220" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id="whale-body" x1="72" y1="47" x2="285" y2="188" gradientUnits="userSpaceOnUse">
            <stop stopColor="#B8F3F0" />
            <stop offset=".42" stopColor="#43C5D0" />
            <stop offset="1" stopColor="#1766A5" />
          </linearGradient>
          <linearGradient id="whale-belly" x1="134" y1="110" x2="248" y2="176" gradientUnits="userSpaceOnUse">
            <stop stopColor="#E5FBFA" stopOpacity=".95" />
            <stop offset="1" stopColor="#8AD9E4" stopOpacity=".15" />
          </linearGradient>
          <filter id="whale-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <g className="ai-whale__trail" opacity=".55">
          <path d="M39 92c-17 11-22 25-25 43M54 108c-13 11-16 22-16 36" stroke="#7AE3E5" strokeWidth="3" strokeLinecap="round" />
          <circle cx="22" cy="68" r="4" fill="#B8F3F0" />
          <circle cx="55" cy="53" r="3" fill="#7AE3E5" />
        </g>
        <g filter="url(#whale-glow)">
          <path
            d="M69 119c12-46 65-70 119-62 34 5 65 22 90 45 20 18 42 18 57 7-3 26-23 43-48 45-20 2-38-5-55-13-14 21-41 37-72 35-49-3-85-22-91-57Z"
            fill="url(#whale-body)"
          />
          <path
            d="M124 129c24 31 62 43 103 25-12 19-37 31-67 29-29-2-54-15-66-35 10-1 20-7 30-19Z"
            fill="url(#whale-belly)"
          />
          <path d="M258 101c9-19 22-29 39-35-4 14-2 28 7 39-17 7-31 5-46-4Z" fill="#69D7DA" />
          <path d="M118 63c-3-18 4-29 16-39 3 13 10 21 22 28-12 7-24 11-38 11Z" fill="#56C7D0" />
          <path d="M136 57c-1-13 4-21 12-28" stroke="#D8FFFF" strokeWidth="4" strokeLinecap="round" />
          <circle cx="111" cy="97" r="6" fill="#082849" />
          <circle cx="113" cy="95" r="2" fill="white" />
          <path d="M89 115c14 8 25 8 38 1" stroke="#D8FFFF" strokeWidth="3" strokeLinecap="round" opacity=".75" />
          <path d="M175 89c17 7 29 20 34 38" stroke="#D8FFFF" strokeWidth="3" strokeLinecap="round" opacity=".35" />
        </g>
      </svg>
      {!compact ? <span className="ai-whale__label">{stateLabels[state]}</span> : null}
      <span className="ai-whale__signal" />
    </div>
  )
}
