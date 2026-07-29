import api from './api'
import type {
  TemplateInfo,
  SheetInfo,
  FieldMappingUpdate,
} from '@/types'

export async function uploadTemplate(file: File): Promise<TemplateInfo> {
  const form = new FormData()
  form.append('file', file)
  const { data } = await api.post<TemplateInfo>('/templates/upload', form)
  return data
}

export async function getCurrentTemplate(): Promise<TemplateInfo | null> {
  const { data } = await api.get<TemplateInfo | null>('/templates/current')
  return data
}

export async function getSheets(templateId: number): Promise<SheetInfo[]> {
  const { data } = await api.get<SheetInfo[]>(`/templates/${templateId}/sheets`)
  return data
}

export interface InspectResult {
  sheet_name: string
  detected_header_row: number
  field_mapping: Record<string, string>
  unmatched: string[]
}

export async function inspectTemplate(
  templateId: number,
  sheetName?: string,
  headerRow?: number,
): Promise<InspectResult> {
  const params: Record<string, string> = {}
  if (sheetName) params.sheet_name = sheetName
  if (headerRow) params.header_row = String(headerRow)
  const { data } = await api.post<InspectResult>(`/templates/${templateId}/inspect`, null, { params })
  return data
}

export async function updateMapping(
  templateId: number,
  config: FieldMappingUpdate,
): Promise<TemplateInfo> {
  const { data } = await api.put<TemplateInfo>(`/templates/${templateId}/mapping`, config)
  return data
}

export interface TestMappingResult {
  sheet_name: string
  header_row: number
  base_write_row: number
  style_source_row: number
  field_mapping: Record<string, string>
  mapped_count: number
  unmapped: string[]
  sample_rows: Array<{ excel_row: number; values: Record<string, string> }>
}

export async function testTemplate(templateId: number): Promise<TestMappingResult> {
  const { data } = await api.post<TestMappingResult>(`/templates/${templateId}/test`)
  return data
}
