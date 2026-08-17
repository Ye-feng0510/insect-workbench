import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CinematicLoginScene from './CinematicLoginScene'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CinematicLoginScene', () => {
  it('keeps the scene phase and form content presentation-independent', () => {
    render(
      <CinematicLoginScene phase="submitting">
        <form aria-label="登录表单" />
      </CinematicLoginScene>,
    )

    const story = screen.getByRole('region', { name: '鲸吟深寻' })
    const scene = story.closest('.login-scene')
    expect(scene).toHaveAttribute('data-phase', 'submitting')
    expect(screen.getByRole('form', { name: '登录表单' })).toBeInTheDocument()
    expect(scene?.querySelectorAll('.login-scene__particles span')).toHaveLength(18)
  })

  it('coalesces pointer parallax updates and cleans up on unmount', () => {
    let scheduledFrame: FrameRequestCallback | undefined
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        scheduledFrame = callback
        return 4
      })
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => undefined)
    const view = render(
      <CinematicLoginScene>
        <div />
      </CinematicLoginScene>,
    )
    const scene = view.container.firstElementChild as HTMLElement

    fireEvent.pointerMove(scene, { clientX: 0, clientY: 0 })
    fireEvent.pointerMove(scene, { clientX: window.innerWidth, clientY: window.innerHeight })
    expect(requestFrame).toHaveBeenCalledTimes(1)

    scheduledFrame?.(16)
    const firstArtX = Number.parseFloat(scene.style.getPropertyValue('--login-art-x'))
    expect(firstArtX).toBeCloseTo(1.71)
    expect(Number.parseFloat(scene.style.getPropertyValue('--login-art-y'))).toBeCloseTo(1.14)
    expect(Number.parseFloat(scene.style.getPropertyValue('--login-light-x'))).toBeCloseTo(-3.23, 1)
    expect(Number.parseFloat(scene.style.getPropertyValue('--login-terminal-ry'))).toBeCloseTo(.304)
    expect(scene).toHaveAttribute('data-pointer-active', 'true')

    fireEvent.pointerLeave(scene)
    scheduledFrame?.(32)
    expect(Number.parseFloat(scene.style.getPropertyValue('--login-art-x'))).toBeLessThan(firstArtX)
    expect(scene).not.toHaveAttribute('data-pointer-active')

    view.unmount()
    expect(cancelFrame).toHaveBeenCalledWith(4)
  })

  it('does not attach animated parallax in reduced-motion mode', () => {
    const originalMatchMedia = window.matchMedia
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: true })),
    })
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame')

    try {
      const view = render(
        <CinematicLoginScene>
          <div />
        </CinematicLoginScene>,
      )
      const scene = view.container.firstElementChild as HTMLElement
      fireEvent.pointerMove(scene, { clientX: window.innerWidth, clientY: window.innerHeight })

      expect(requestFrame).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: originalMatchMedia,
      })
    }
  })
})
