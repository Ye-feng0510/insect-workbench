import { describe, expect, it, vi } from 'vitest'
import {
  getNextWorkbenchTheme,
  getThemeRevealRadius,
  loadWorkbenchTheme,
  saveWorkbenchTheme,
  WORKBENCH_THEME_STORAGE_KEY,
} from './workbenchTheme'

describe('workbench theme model', () => {
  it('defaults invalid or unavailable storage values to day mode', () => {
    const storage = {
      getItem: vi.fn(() => 'unknown'),
    } as unknown as Storage

    expect(loadWorkbenchTheme(undefined)).toBe('day')
    expect(loadWorkbenchTheme(storage)).toBe('day')
  })

  it('loads and saves supported themes without leaking storage failures', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    } as unknown as Storage

    saveWorkbenchTheme(storage, 'night')

    expect(values.get(WORKBENCH_THEME_STORAGE_KEY)).toBe('night')
    expect(loadWorkbenchTheme(storage)).toBe('night')
    expect(() => saveWorkbenchTheme({
      setItem: () => {
        throw new Error('blocked')
      },
    } as unknown as Storage, 'day')).not.toThrow()
  })

  it('computes a reveal radius that reaches the farthest viewport corner', () => {
    expect(getThemeRevealRadius({ x: 40, y: 760 }, 1200, 800))
      .toBeCloseTo(Math.hypot(1160, 760))
    expect(getNextWorkbenchTheme('day')).toBe('night')
    expect(getNextWorkbenchTheme('night')).toBe('day')
  })
})
