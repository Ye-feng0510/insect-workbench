export type PetActivity =
  | 'idle'
  | 'extracting'
  | 'resolving'
  | 'awaiting-confirmation'
  | 'saving'
  | 'success'
  | 'error'

export type PetAnimation =
  | 'idle'
  | 'running-right'
  | 'jumping'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'review'

export interface PetTrack {
  row: number
  frames: number
  durations: number[]
  loop: boolean
}

export const PET_CELL = { width: 192, height: 208 }
export const PET_COLUMNS = 8
export const PET_ROWS = 9

export const ACTIVITY_LABELS: Record<PetActivity, string> = {
  idle: '鲸鱼娘正在陪你整理标本',
  extracting: '正在读取标本图片',
  resolving: '正在核验权威分类',
  'awaiting-confirmation': '等待你确认识别结果',
  saving: '正在写入标本记录',
  success: '这一轮整理完成啦',
  error: '遇到问题了，请检查提示',
}

export const ANIMATION_BY_ACTIVITY: Record<PetActivity, PetAnimation> = {
  idle: 'idle',
  extracting: 'running',
  resolving: 'running-right',
  'awaiting-confirmation': 'waiting',
  saving: 'review',
  success: 'jumping',
  error: 'failed',
}

export const PET_TRACKS: Record<PetAnimation, PetTrack> = {
  idle: { row: 0, frames: 6, durations: [400, 400, 500, 400, 400, 500], loop: true },
  'running-right': { row: 1, frames: 8, durations: Array(8).fill(225), loop: true },
  jumping: { row: 4, frames: 5, durations: [300, 300, 300, 350, 350], loop: true },
  failed: { row: 5, frames: 8, durations: [450, 450, 450, 500, 550, 600, 450, 450], loop: true },
  waiting: { row: 6, frames: 6, durations: [450, 450, 500, 450, 450, 500], loop: true },
  running: { row: 7, frames: 6, durations: Array(6).fill(250), loop: true },
  review: { row: 8, frames: 6, durations: Array(6).fill(550), loop: true },
}

export function frameOffset(
  animation: PetAnimation,
  frame: number,
  scale: number,
): { x: number; y: number } {
  const track = PET_TRACKS[animation]
  const column = Math.max(0, Math.min(frame, track.frames - 1))
  return {
    x: -column * PET_CELL.width * scale,
    y: -track.row * PET_CELL.height * scale,
  }
}
