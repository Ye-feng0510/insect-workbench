import api from './api'
import type {
  MaterialExtractResponse,
  MaterialItemInfo,
  MaterialStatus,
  MaterialSummary,
} from '@/types'

export async function getMaterialSummary(): Promise<MaterialSummary> {
  const { data } = await api.get<MaterialSummary>('/materials/summary')
  return data
}

export async function listMaterialItems(
  status?: MaterialStatus,
  limit = 200,
): Promise<MaterialItemInfo[]> {
  const { data } = await api.get<MaterialItemInfo[]>('/materials/items', {
    params: { status, limit },
  })
  return data
}

export async function uploadMaterialZip(file: File): Promise<MaterialSummary> {
  const form = new FormData()
  form.append('file', file)
  const { data } = await api.post<MaterialSummary>('/materials/upload', form, {
    timeout: 0,
  })
  return data
}

export async function extractNextMaterial(): Promise<MaterialExtractResponse> {
  const { data } = await api.post<MaterialExtractResponse>(
    '/materials/next-extract',
    null,
    { timeout: 130_000 },
  )
  return data
}

export async function skipMaterial(itemId: number): Promise<MaterialSummary> {
  const { data } = await api.post<MaterialSummary>(`/materials/${itemId}/skip`)
  return data
}

export async function deleteMaterialBatch(): Promise<MaterialSummary> {
  const { data } = await api.delete<MaterialSummary>('/materials/batch')
  return data
}

export const skippedMaterialsExportUrl = '/api/materials/skipped/export'
