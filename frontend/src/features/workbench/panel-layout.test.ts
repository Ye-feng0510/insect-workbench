import { beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_PANEL_DEFAULTS,
  AGENT_PANEL_LAYOUT_KEY,
  calculateAgentPanelWidths,
  isAgentWorkbenchPath,
  loadAgentPanelRatios,
  saveAgentPanelRatios,
} from './panel-layout'

describe('agent panel layout', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('uses desktop defaults and preserves the middle minimum', () => {
    expect(calculateAgentPanelWidths({
      leftRatio: AGENT_PANEL_DEFAULTS.leftRatio,
      rightRatio: AGENT_PANEL_DEFAULTS.rightRatio,
    }, 1920)).toEqual({ left: 240, right: 400 })

    const constrained = calculateAgentPanelWidths({
      leftRatio: 0.5,
      rightRatio: 0.5,
    }, 1280)
    expect(constrained.left + constrained.right).toBeLessThanOrEqual(
      1280 - AGENT_PANEL_DEFAULTS.handleTotal - AGENT_PANEL_DEFAULTS.middleMin,
    )
  })

  it('keeps the existing fixed layout below the desktop breakpoint', () => {
    expect(calculateAgentPanelWidths({
      leftRatio: 0.3,
      rightRatio: 0.4,
    }, 1024)).toEqual({ left: 240, right: 400 })
  })

  it('recognizes the agent route with or without a trailing slash', () => {
    expect(isAgentWorkbenchPath('/agent-workbench')).toBe(true)
    expect(isAgentWorkbenchPath('/agent-workbench/')).toBe(true)
    expect(isAgentWorkbenchPath('/workbench')).toBe(false)
  })

  it('persists valid ratios and rejects corrupt values', () => {
    saveAgentPanelRatios(localStorage, {
      leftRatio: 0.18,
      rightRatio: 0.32,
    })
    expect(loadAgentPanelRatios(localStorage)).toEqual({
      leftRatio: 0.18,
      rightRatio: 0.32,
    })

    localStorage.setItem(AGENT_PANEL_LAYOUT_KEY, '{"version":1,"leftRatio":"bad"}')
    expect(loadAgentPanelRatios(localStorage)).toEqual({
      leftRatio: AGENT_PANEL_DEFAULTS.leftRatio,
      rightRatio: AGENT_PANEL_DEFAULTS.rightRatio,
    })
  })

  it('treats unavailable browser storage as non-fatal', () => {
    const blockedStorage = {
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError')
      },
      setItem: () => {
        throw new DOMException('blocked', 'SecurityError')
      },
    } as unknown as Storage

    expect(loadAgentPanelRatios(blockedStorage)).toEqual({
      leftRatio: AGENT_PANEL_DEFAULTS.leftRatio,
      rightRatio: AGENT_PANEL_DEFAULTS.rightRatio,
    })
    expect(() => saveAgentPanelRatios(blockedStorage, {
      leftRatio: 0.2,
      rightRatio: 0.3,
    })).not.toThrow()
  })
})
