import { useEffect, useRef } from 'react'
import {
  LOGIN_MOTION,
  clampMotionPoint,
  type LoginMotionPoint,
} from './loginMotion'

export default function useLoginParallax() {
  const sceneRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const scene = sceneRef.current
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches
    if (!scene || reducedMotion || coarsePointer) return

    let frame = 0
    let current: LoginMotionPoint = { x: 0, y: 0 }
    let target: LoginMotionPoint = { x: 0, y: 0 }

    const writeMotion = (point: LoginMotionPoint) => {
      const { art, light, particles, story, terminal, glow } = LOGIN_MOTION
      scene.style.setProperty('--login-art-x', `${point.x * art.x}px`)
      scene.style.setProperty('--login-art-y', `${point.y * art.y}px`)
      scene.style.setProperty('--login-light-x', `${point.x * light.x}px`)
      scene.style.setProperty('--login-light-y', `${point.y * light.y}px`)
      scene.style.setProperty('--login-particle-x', `${point.x * particles.x}px`)
      scene.style.setProperty('--login-particle-y', `${point.y * particles.y}px`)
      scene.style.setProperty('--login-story-x', `${point.x * story.x}px`)
      scene.style.setProperty('--login-story-y', `${point.y * story.y}px`)
      scene.style.setProperty('--login-terminal-x', `${point.x * terminal.x}px`)
      scene.style.setProperty('--login-terminal-y', `${point.y * terminal.y}px`)
      scene.style.setProperty('--login-terminal-rx', `${point.y * terminal.rotateX}deg`)
      scene.style.setProperty('--login-terminal-ry', `${point.x * terminal.rotateY}deg`)
      scene.style.setProperty('--login-glow-x', `${50 + point.x * glow.x}%`)
      scene.style.setProperty('--login-glow-y', `${42 + point.y * glow.y}%`)
    }

    const animate = () => {
      const deltaX = target.x - current.x
      const deltaY = target.y - current.y
      current = {
        x: current.x + deltaX * LOGIN_MOTION.damping,
        y: current.y + deltaY * LOGIN_MOTION.damping,
      }
      writeMotion(current)
      if (
        Math.abs(deltaX) > LOGIN_MOTION.settleThreshold
        || Math.abs(deltaY) > LOGIN_MOTION.settleThreshold
      ) {
        frame = window.requestAnimationFrame(animate)
      } else {
        current = target
        writeMotion(current)
        frame = 0
      }
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      target = clampMotionPoint({
        x: ((event.clientX / window.innerWidth) - .5) * 2,
        y: ((event.clientY / window.innerHeight) - .5) * 2,
      })
      scene.dataset.pointerActive = 'true'
      if (!frame) frame = window.requestAnimationFrame(animate)
    }

    const handlePointerLeave = () => {
      target = { x: 0, y: 0 }
      delete scene.dataset.pointerActive
      if (!frame) frame = window.requestAnimationFrame(animate)
    }

    scene.addEventListener('pointermove', handlePointerMove)
    scene.addEventListener('pointerleave', handlePointerLeave)

    return () => {
      scene.removeEventListener('pointermove', handlePointerMove)
      scene.removeEventListener('pointerleave', handlePointerLeave)
      window.cancelAnimationFrame(frame)
    }
  }, [])

  return sceneRef
}
