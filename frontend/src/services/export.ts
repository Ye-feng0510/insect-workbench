import api from './api'
import type { ExportSummary, ExportResult } from '@/types'

export async function getExportSummary(): Promise<ExportSummary> {
  const { data } = await api.get<ExportSummary>('/export/summary')
  return data
}

export async function exportExcel(): Promise<ExportResult> {
  const { data } = await api.post<ExportResult>('/export/excel')
  return data
}
