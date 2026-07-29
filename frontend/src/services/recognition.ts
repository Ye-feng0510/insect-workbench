import api from './api'
import type {
  ExtractResponse,
  ConfirmExtractionRequest,
  ConfirmExtractionResponse,
} from '@/types'

export async function extractImage(
  file: File,
  rotationDegrees: number = 0,
): Promise<ExtractResponse> {
  const form = new FormData()
  form.append('file', file)
  form.append('rotation_degrees', String(rotationDegrees))
  const { data } = await api.post<ExtractResponse>('/recognition/extract', form, {
    timeout: 130_000,
  })
  return data
}

export async function reExtract(recordId: number): Promise<ExtractResponse> {
  const { data } = await api.post<ExtractResponse>(
    `/recognition/${recordId}/re-extract`,
    null,
    { timeout: 130_000 },
  )
  return data
}

export async function confirmExtraction(
  recordId: number,
  confirmed: Record<string, string>,
  duplicateAction?: string | null,
): Promise<ConfirmExtractionResponse> {
  const body: ConfirmExtractionRequest = { confirmed }
  if (duplicateAction) body.duplicate_action = duplicateAction
  const { data } = await api.post<ConfirmExtractionResponse>(
    `/recognition/${recordId}/confirm-extraction`,
    body,
    { timeout: 130_000 },
  )
  return data
}
