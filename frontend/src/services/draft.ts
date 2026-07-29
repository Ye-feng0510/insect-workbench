import api from './api'
import type { RecordDetail } from '@/types'

/** 获取当前活跃草稿(用于页面刷新后恢复)。 */
export async function getActiveDraft(): Promise<RecordDetail | null> {
  const { data } = await api.get<RecordDetail | null>('/recognition/active-draft')
  return data
}

/** 放弃当前草稿。 */
export async function discardDraft(recordId: number): Promise<void> {
  await api.post(`/recognition/${recordId}/discard`)
}

/** 获取记录图片(通过代理路径)。 */
export function imageUrl(imagePath: string): string {
  // imagePath 是绝对路径,后端通过 /api/recognition/image 端点返回
  const filename = imagePath.split(/[\\/]/).pop()
  return `/api/recognition/image/${filename}`
}
