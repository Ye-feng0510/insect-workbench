import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ThemeToggle from './ThemeToggle'
import { WorkbenchThemeProvider } from './WorkbenchThemeProvider'
import { WORKBENCH_THEME_STORAGE_KEY } from './workbenchTheme'

function renderTheme() {
  return render(
    <WorkbenchThemeProvider>
      <ThemeToggle />
      <p>workbench content</p>
    </WorkbenchThemeProvider>,
  )
}

describe('WorkbenchThemeProvider', () => {
  const originalMatchMedia = window.matchMedia

  beforeEach(() => {
    localStorage.clear()
    delete document.documentElement.dataset.workbenchTheme
    Reflect.deleteProperty(document, 'startViewTransition')
    document.documentElement.className = ''
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (originalMatchMedia) {
      window.matchMedia = originalMatchMedia
    } else {
      Reflect.deleteProperty(window, 'matchMedia')
    }
  })

  it('defaults to day, persists a fallback toggle, and cleans up on unmount', async () => {
    const view = renderTheme()
    const toggle = screen.getByRole('switch', { name: '切换到夜间护眼模式' })

    expect(document.documentElement).toHaveAttribute('data-workbench-theme', 'day')
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(toggle)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-workbench-theme', 'night')
      expect(localStorage.getItem(WORKBENCH_THEME_STORAGE_KEY)).toBe('night')
      expect(toggle).toHaveAttribute('aria-checked', 'true')
    })

    view.unmount()
    expect(document.documentElement).not.toHaveAttribute('data-workbench-theme')
  })

  it('restores a persisted night theme before rendering authenticated content', () => {
    localStorage.setItem(WORKBENCH_THEME_STORAGE_KEY, 'night')

    renderTheme()

    expect(document.documentElement).toHaveAttribute('data-workbench-theme', 'night')
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  })

  it('reveals the new theme from the toggle center through View Transition', async () => {
    let finishTransition: (() => void) | undefined
    const finished = new Promise<void>((resolve) => {
      finishTransition = resolve
    })
    const startViewTransition = vi.fn((callback: () => void) => {
      callback()
      return { finished }
    })
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: startViewTransition,
    })
    const view = renderTheme()
    const toggle = screen.getByRole('switch')
    vi.spyOn(toggle, 'getBoundingClientRect').mockReturnValue({
      x: 10,
      y: 720,
      left: 10,
      top: 720,
      right: 50,
      bottom: 760,
      width: 40,
      height: 40,
      toJSON: () => ({}),
    })

    fireEvent.click(toggle)

    expect(startViewTransition).toHaveBeenCalledTimes(1)
    expect(document.documentElement.style.getPropertyValue('--theme-transition-x')).toBe('30px')
    expect(document.documentElement.style.getPropertyValue('--theme-transition-y')).toBe('740px')
    expect(document.documentElement).toHaveClass('workbench-theme-transitioning')
    expect(toggle).toBeDisabled()

    await act(async () => {
      finishTransition?.()
      await finished
    })
    await waitFor(() => expect(toggle).not.toBeDisabled())
    expect(document.documentElement).not.toHaveClass('workbench-theme-transitioning')

    view.unmount()
  })

  it('skips the expanding transition when reduced motion is requested', () => {
    const startViewTransition = vi.fn()
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: startViewTransition,
    })
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: true })),
    })
    renderTheme()

    fireEvent.click(screen.getByRole('switch'))

    expect(startViewTransition).not.toHaveBeenCalled()
    expect(document.documentElement).toHaveAttribute('data-workbench-theme', 'night')
    expect(screen.getByRole('switch')).not.toBeDisabled()
  })

  it('survives StrictMode setup and removes pending transition state on unmount', async () => {
    let finishTransition: (() => void) | undefined
    const finished = new Promise<void>((resolve) => {
      finishTransition = resolve
    })
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: (callback: () => void) => {
        callback()
        return { finished }
      },
    })
    const view = render(
      <StrictMode>
        <WorkbenchThemeProvider>
          <ThemeToggle />
        </WorkbenchThemeProvider>
      </StrictMode>,
    )

    fireEvent.click(screen.getByRole('switch'))
    expect(document.documentElement).toHaveClass('workbench-theme-transitioning')

    view.unmount()
    expect(document.documentElement).not.toHaveAttribute('data-workbench-theme')
    expect(document.documentElement).not.toHaveClass('workbench-theme-transitioning')

    await act(async () => {
      finishTransition?.()
      await finished
    })
    expect(document.documentElement).not.toHaveAttribute('data-workbench-theme')
  })

  it('falls back safely when View Transition startup fails', () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: () => {
        throw new Error('unsupported')
      },
    })
    renderTheme()

    fireEvent.click(screen.getByRole('switch'))

    expect(document.documentElement).toHaveAttribute('data-workbench-theme', 'night')
    expect(document.documentElement).toHaveClass('workbench-theme-fallback')
    expect(screen.getByRole('switch')).toBeDisabled()

    act(() => vi.advanceTimersByTime(460))
    expect(document.documentElement).not.toHaveClass('workbench-theme-fallback')
    expect(screen.getByRole('switch')).not.toBeDisabled()
  })
})
