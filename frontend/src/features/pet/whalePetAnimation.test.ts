import { describe, expect, it } from 'vitest'
import {
  ANIMATION_BY_ACTIVITY,
  PET_CELL,
  frameOffset,
} from './whalePetAnimation'

describe('whalePetAnimation', () => {
  it('maps workbench activity to presentation-only animation tracks', () => {
    expect(ANIMATION_BY_ACTIVITY.extracting).toBe('running')
    expect(ANIMATION_BY_ACTIVITY.resolving).toBe('running-right')
    expect(ANIMATION_BY_ACTIVITY['awaiting-confirmation']).toBe('waiting')
    expect(ANIMATION_BY_ACTIVITY.saving).toBe('review')
    expect(ANIMATION_BY_ACTIVITY.success).toBe('jumping')
    expect(ANIMATION_BY_ACTIVITY.error).toBe('failed')
  })

  it('calculates scaled sprite offsets and clamps the frame', () => {
    expect(frameOffset('running', 2, 0.5)).toEqual({
      x: -PET_CELL.width,
      y: -7 * PET_CELL.height * 0.5,
    })
    expect(frameOffset('jumping', 99, 1).x).toBe(-4 * PET_CELL.width)
  })
})
