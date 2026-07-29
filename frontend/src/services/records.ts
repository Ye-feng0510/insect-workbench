import api from './api'
import type { RecordDetail } from '@/types'

export async function listRecords(
  search?: string,
  status?: string,
): Promise<RecordDetail[]> {
  const params: Record<string, string> = {}
  if (search) params.search = search
  if (status) params.status = status
  const { data } = await api.get<RecordDetail[]>('/records', { params })
  return data
}

export async function getRecord(id: number): Promise<RecordDetail> {
  const { data } = await api.get<RecordDetail>(`/records/${id}`)
  return data
}

export async function updateRecord(
  id: number,
  fields: Record<string, string>,
): Promise<RecordDetail> {
  const { data } = await api.patch<RecordDetail>(`/records/${id}`, { fields })
  return data
}

export async function deleteRecord(id: number): Promise<void> {
  await api.delete(`/records/${id}`)
}

export async function reclassifyRecord(id: number): Promise<{
  record_id: number
  status: string
  fields: Record<string, string>
  excel_row: number
  warnings: string[]
}> {
  const { data } = await api.post(`/records/${id}/reclassify`, null, {
    timeout: 130_000,
  })
  return data
}
