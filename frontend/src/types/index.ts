/** 后端 API 类型定义 */

export interface ModelConfig {
  base_url: string
  api_key: string
  model_name: string
}

export type UserRole = 'admin' | 'user'

export interface AuthUser {
  id: number
  username: string
  role: UserRole
  is_active: boolean
  workflow_quota: number | null
  workflow_reserved: number
  workflow_charged: number
  created_at?: string
  last_login_at?: string | null
}

export interface LoginResponse {
  user: AuthUser
  csrf_token?: string
}

export interface CreateUserRequest {
  username: string
  password: string
  role: UserRole
  workflow_quota: number | null
}

export interface QuotaAdjustment {
  id: number
  user_id: number
  actor_user_id: number
  old_quota: number | null
  new_quota: number | null
  reason: string
  created_at: string
}

export interface WorkflowUsage {
  id: number
  user_id: number
  record_id: number | null
  status: 'reserved' | 'charged' | 'released'
  reserved_at: string
  charged_at: string | null
  released_at: string | null
}

export interface AdminDataSummary {
  user_id: number
  username: string
  records: number
  material_batches: number
  material_items: number
  workflow_sessions: number
  taxonomy_cache: number
  exports: number
  record_bytes: number
  material_bytes: number
  export_bytes: number
  charged_usage: number
}

export interface AdminDataResetResult {
  user_id: number
  released_bytes: number
  failed_paths: string[]
  summary: AdminDataSummary
}

export interface PromptConfig {
  recognition_prompt: string
  taxonomy_prompt: string
}

export interface TestResult {
  passed: boolean
  message: string
}

export interface TestModelResponse {
  image_test: TestResult
  text_json_test: TestResult
  overall: boolean
}

export interface ModelsListResponse {
  models: string[]
}

export interface SheetInfo {
  name: string
  rows: number
  cols: number
}

export interface FieldMappingUpdate {
  target_sheet: string
  header_row: number
  start_row: number
  style_source_row: number
  field_mapping: Record<string, string>
}

export interface TemplateInfo {
  id: number
  original_filename: string
  target_sheet: string
  header_row: number
  start_row: number
  base_write_row: number
  style_source_row: number
  field_mapping: Record<string, string>
  is_active: boolean
  created_at: string
}

export interface ExtractResponse {
  record_id: number
  status: string
  image_url: string
  extracted: Record<string, string>
  confidence: Record<string, string>
  evidence: Record<string, string>
  warnings: string[]
}

export interface ConfirmExtractionRequest {
  confirmed: Record<string, string>
  duplicate_action?: string | null
}

export interface ConfirmExtractionResponse {
  record_id: number
  status: string
  fields: Record<string, string>
  excel_row: number
  warnings: string[]
}

export interface RecordSummary {
  id: number
  image_filename: string
  status: string
  zhongming: string
  chandi3: string
  tuxiang: string
  caijiren: string
  caiji_riqi: string
  created_at: string
  updated_at: string
}

export interface RecordDetail {
  id: number
  image_filename: string
  image_path: string
  image_url: string
  processed_image_path: string
  rotation_degrees: number
  status: string
  extracted_draft: Record<string, unknown>
  confirmed_extraction: Record<string, unknown>
  taxonomy_result: Record<string, unknown>
  warnings: string[]
  fields: Record<string, string>
  created_at: string
  updated_at: string
  material_item_id?: number
  material_batch_id?: number
}

export type MaterialStatus = 'pending' | 'processing' | 'completed' | 'skipped' | 'failed'

export interface MaterialBatchInfo {
  id: number
  original_filename: string
  total_count: number
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface MaterialItemInfo {
  id: number
  batch_id: number
  sequence: number
  original_filename: string
  archive_path: string
  status: MaterialStatus
  record_id: number | null
  error_message: string
  created_at: string
  updated_at: string
}

export interface MaterialSummary {
  batch: MaterialBatchInfo | null
  total_count: number
  pending_count: number
  processing_count: number
  completed_count: number
  skipped_count: number
  failed_count: number
  quota_total: number | null
  quota_charged: number
  quota_reserved: number
  quota_remaining: number | null
  quota_exhausted: boolean
}

export interface MaterialPreview {
  item_id: number
  filename: string
  image_url: string
}

export interface MaterialPrefetchStatus {
  ready_count: number
  running_count: number
  failed_count: number
  target: number
}

export interface MaterialExtractResponse extends ExtractResponse {
  material_item_id: number
  batch_id: number
  original_filename: string
  pending_count: number
}

export interface PreviewColumn {
  letter: string
  field: string
}

export interface PreviewRow {
  excel_row: number
  record_id: number | null
  status: string
  values: Record<string, string>
}

export interface PreviewResponse {
  sheet_name: string
  mode: string
  header_row: number
  base_write_row: number
  columns: PreviewColumn[]
  rows: PreviewRow[]
  completed_count: number
  offset: number
  limit: number
  has_more: boolean
  latest_write_row: number | null
  next_write_row: number
  last_updated: string
}

export interface ExportSummary {
  completed_count: number
  awaiting_confirmation_count: number
  template_name: string
  target_sheet: string
  start_write_row: number
}

export interface ExportResult {
  filename: string
  download_url: string
  record_count: number
}

/** 提取后端错误消息。 */
export function extractErrorMessage(err: unknown, fallback = '操作失败'): string {
  if (err && typeof err === 'object') {
    const any = err as { response?: { data?: { detail?: unknown } }; message?: string }
    const detail = any.response?.data?.detail
    if (typeof detail === 'string' && detail) return detail
    if (Array.isArray(detail)) {
      const messages = detail.flatMap((item) => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object') {
          const message = (item as { msg?: unknown }).msg
          return typeof message === 'string' ? message : []
        }
        return []
      })
      if (messages.length > 0) return messages.join('；')
    }
    if (detail && typeof detail === 'object') {
      const message = (detail as { message?: unknown }).message
      if (typeof message === 'string' && message) return message
    }
    if (any.message) return any.message
  }
  return fallback
}
