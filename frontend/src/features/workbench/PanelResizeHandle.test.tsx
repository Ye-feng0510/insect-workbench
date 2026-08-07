import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import PanelResizeHandle from './PanelResizeHandle'

describe('PanelResizeHandle', () => {
  it('exposes separator accessibility metadata', () => {
    render(
      <PanelResizeHandle
        side="right"
        currentWidth={420}
        maxWidth={600}
        active={false}
        onPointerDown={vi.fn()}
        onWidthChange={vi.fn()}
        onReset={vi.fn()}
      />,
    )

    const separator = screen.getByRole('separator', {
      name: '调整右侧预览宽度',
    })
    expect(separator).toHaveAttribute('aria-controls', 'agent-inspector-panel')
    expect(separator).toHaveAttribute('aria-valuenow', '420')
    expect(separator).toHaveAttribute('aria-valuemax', '600')
    expect(separator).toHaveAttribute('tabindex', '0')
  })

  it('supports keyboard resizing and reset', () => {
    const onWidthChange = vi.fn()
    const onReset = vi.fn()
    render(
      <PanelResizeHandle
        side="left"
        currentWidth={240}
        maxWidth={350}
        active={false}
        onPointerDown={vi.fn()}
        onWidthChange={onWidthChange}
        onReset={onReset}
      />,
    )

    const separator = screen.getByRole('separator')
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(onWidthChange).toHaveBeenLastCalledWith(250)
    fireEvent.keyDown(separator, { key: 'ArrowLeft', shiftKey: true })
    expect(onWidthChange).toHaveBeenLastCalledWith(200)
    fireEvent.keyDown(separator, { key: 'End' })
    expect(onWidthChange).toHaveBeenLastCalledWith(350)
    fireEvent.doubleClick(separator)
    expect(onReset).toHaveBeenCalledOnce()
  })
})
