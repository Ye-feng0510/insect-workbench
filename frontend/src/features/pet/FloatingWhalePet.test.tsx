import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PetActivityProvider,
} from './PetActivityContext'
import { usePetActivityState, useReportPetActivity } from './usePetActivity'
import FloatingWhalePet from './FloatingWhalePet'
import type { PetActivity } from './whalePetAnimation'

function Reporter({ activity }: { activity: PetActivity }) {
  useReportPetActivity(activity)
  return null
}

function ActivityReader() {
  return <output>{usePetActivityState()}</output>
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('FloatingWhalePet', () => {
  it('renders the current workbench state with an accessible label', async () => {
    render(
      <PetActivityProvider>
        <Reporter activity="resolving" />
        <FloatingWhalePet />
      </PetActivityProvider>,
    )

    expect(await screen.findByRole('button', { name: /正在核验权威分类/ })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('正在核验权威分类')
  })

  it('shows a short celebration after active work settles', () => {
    vi.useFakeTimers()
    const view = render(
      <PetActivityProvider>
        <Reporter activity="extracting" />
        <ActivityReader />
      </PetActivityProvider>,
    )

    expect(screen.getByText('extracting')).toBeInTheDocument()
    view.rerender(
      <PetActivityProvider>
        <Reporter activity="idle" />
        <ActivityReader />
      </PetActivityProvider>,
    )
    expect(screen.getByText('success')).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(2400))
    expect(screen.getByText('idle')).toBeInTheDocument()
  })

  it('coalesces pointer movement into animation frames and persists the final position', () => {
    let scheduledFrame: FrameRequestCallback | undefined
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        scheduledFrame = callback
        return 7
      })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)

    render(
      <PetActivityProvider>
        <FloatingWhalePet />
      </PetActivityProvider>,
    )

    const sprite = screen.getByRole('button', { name: /鲸鱼娘正在陪你整理标本/ })
    const pet = screen.getByTestId('floating-whale-pet')
    fireEvent.pointerDown(sprite, { pointerId: 1, clientX: 500, clientY: 500 })
    fireEvent.pointerMove(sprite, { pointerId: 1, clientX: 490, clientY: 495 })
    fireEvent.pointerMove(sprite, { pointerId: 1, clientX: 480, clientY: 490 })

    expect(requestFrame).toHaveBeenCalledTimes(1)
    act(() => scheduledFrame?.(16))
    expect(pet.style.translate).toBe('-48px -34px')

    fireEvent.pointerUp(sprite, { pointerId: 1, clientX: 480, clientY: 490 })
    expect(JSON.parse(localStorage.getItem('insect-workbench:whale-pet-position') ?? '')).toEqual({
      right: 48,
      bottom: 34,
    })
    expect(pet.style.translate).toBe('-48px -34px')
  })
})
