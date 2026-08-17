export const LOGIN_MOTION = {
  art: { x: 18, y: 12 },
  light: { x: -34, y: -24 },
  particles: { x: -26, y: -18 },
  story: { x: 7, y: 5 },
  terminal: { x: 6, y: 4, rotateX: -2.6, rotateY: 3.2 },
  glow: { x: 24, y: 18 },
  damping: .095,
  settleThreshold: .001,
} as const

export interface LoginMotionPoint {
  x: number
  y: number
}

export function clampMotionPoint(point: LoginMotionPoint): LoginMotionPoint {
  return {
    x: Math.max(-1, Math.min(1, point.x)),
    y: Math.max(-1, Math.min(1, point.y)),
  }
}
