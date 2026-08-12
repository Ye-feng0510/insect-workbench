import api from './api'
import type { PreviewResponse } from '@/types'

export async function getPreview(
  mode: 'target' | 'all' = 'target',
  limit: number = 100,
  offset: number = 0,
): Promise<PreviewResponse> {
  const { data } = await api.get<PreviewResponse>('/excel/preview', {
    params: { mode, limit, offset },
  })
  return data
}
