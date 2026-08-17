import type { ReactNode } from 'react'
import useLoginParallax from './useLoginParallax'
import './loginScene.css'

export type LoginScenePhase = 'idle' | 'editing' | 'submitting' | 'error'

interface CinematicLoginSceneProps {
  children: ReactNode
  phase?: LoginScenePhase
}

const PARTICLES = Array.from({ length: 18 }, (_, index) => index)

export default function CinematicLoginScene({
  children,
  phase = 'idle',
}: CinematicLoginSceneProps) {
  const sceneRef = useLoginParallax()

  return (
    <div ref={sceneRef} className="login-scene" data-phase={phase}>
      <div className="login-scene__art" aria-hidden="true" />
      <div className="login-scene__depth" aria-hidden="true" />
      <div className="login-scene__currents" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="login-scene__caustics" aria-hidden="true">
        <span />
        <span />
      </div>
      <div className="login-scene__mist" aria-hidden="true" />
      <div className="login-scene__particles" aria-hidden="true">
        {PARTICLES.map((particle) => <span key={particle} />)}
      </div>

      <div className="login-scene__content">
        <section className="login-scene__story" aria-label="鲸吟深寻">
          <div className="login-scene__story-enter">
            <p className="login-scene__eyebrow">
              <span className="login-scene__signal" />
              SPECIMEN INTELLIGENCE ARCHIVE
            </p>
            <p className="login-scene__title">
              <span>鲸吟</span>
              <i>·</i>
              <strong>深寻</strong>
            </p>
            <p className="login-scene__description">
              让标本图像沉淀为可追溯的自然知识，
              <br />
              在深海般广阔的数据中寻找可靠答案。
            </p>
            <div className="login-scene__signature" aria-hidden="true">
              <span>DEEP OCEAN INTELLIGENCE</span>
              <span>01 / SPECIMEN ARCHIVE</span>
            </div>
          </div>
        </section>

        <div className="login-scene__terminal">
          <div className="login-scene__terminal-float">{children}</div>
        </div>
      </div>

      <div className="login-scene__footer" aria-hidden="true">
        <span>AI-ASSISTED SPECIMEN WORKBENCH</span>
        <span>深度探索 · 明确确认 · 安全归档</span>
      </div>
    </div>
  )
}
