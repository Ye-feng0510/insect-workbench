import api from './api'

export type VerificationStatus =
  | 'verified'
  | 'partially_verified'
  | 'unresolved'
  | string

export interface WorkflowMessage {
  id?: number | string
  role?: 'assistant' | 'user' | 'system' | string
  actor?: 'assistant' | 'user' | 'system' | string
  content: string | Record<string, unknown>
  created_at?: string
  kind?: string
  message_type?: string
}

export interface TaxonomySource {
  title?: string
  label?: string
  url?: string
  href?: string
  citation?: string
}

export interface TaxonomyWorkflowData {
  proposal?: Record<string, unknown> | null
  resolution?: Record<string, unknown> | null
  provenance?: unknown
  verification?: VerificationStatus | Record<string, unknown> | null
  verification_status?: VerificationStatus
  sources?: TaxonomySource[]
  warnings?: string[]
  conflicts?: string[]
  internal?: Record<string, unknown>
  internal_taxonomy?: Record<string, unknown>
}

/**
 * The workflow API is additive and may expose record/taxonomy data either at
 * the top level or under `record`/`taxonomy`. Keep the transport type tolerant
 * so clients remain compatible while the backend contract evolves.
 */
export interface WorkflowDetail {
  id?: number
  revision?: number
  record_id?: number
  status?: string
  state?: string
  stage?: string
  image_filename?: string
  image_url?: string
  rotation_degrees?: number
  material_item_id?: number | null
  material_batch_id?: number | null
  fields?: Record<string, unknown>
  extracted?: Record<string, unknown>
  confirmed?: Record<string, unknown>
  recognition?: Record<string, unknown>
  record?: Record<string, unknown>
  resolution?: Record<string, unknown> | null
  scientific_name?: string
  scientific_name_authorship?: string
  subfamily?: string
  tribe?: string
  subgenus?: string
  taxonomy?: TaxonomyWorkflowData | Record<string, unknown> | null
  taxonomy_proposal?: Record<string, unknown> | null
  taxonomy_resolution?: Record<string, unknown> | null
  provenance?: unknown
  verification?: VerificationStatus | Record<string, unknown> | null
  verification_status?: VerificationStatus
  sources?: TaxonomySource[]
  warnings?: string[]
  conflicts?: string[]
  messages?: WorkflowMessage[]
  excel_row?: number | null
  [key: string]: unknown
}

export interface ResolveTaxonomyRequest {
  confirmed: Record<string, string>
  scientific_name: string
  authorship: string
}

export interface CommitWorkflowRequest {
  expected_revision: number
  taxonomy: Record<string, string>
  confirmed?: Record<string, string>
  duplicate_action?: string
  manual_override_reason?: string
}

export interface CommitWorkflowResponse extends WorkflowDetail {
  excel_row?: number
}

export async function getActiveWorkflow(): Promise<WorkflowDetail | null> {
  const { data } = await api.get<WorkflowDetail | null>('/workflows/active')
  return data
}

export async function getWorkflow(recordId: number): Promise<WorkflowDetail> {
  const { data } = await api.get<WorkflowDetail>(`/workflows/${recordId}`)
  return data
}

export async function resolveTaxonomy(
  recordId: number,
  body: ResolveTaxonomyRequest,
): Promise<WorkflowDetail> {
  const { data } = await api.post<WorkflowDetail>(
    `/workflows/${recordId}/resolve-taxonomy`,
    body,
    { timeout: 130_000 },
  )
  return data
}

export async function postWorkflowMessage(
  recordId: number,
  content: string,
): Promise<WorkflowDetail | WorkflowMessage> {
  const { data } = await api.post<WorkflowDetail | WorkflowMessage>(
    `/workflows/${recordId}/messages`,
    { content },
  )
  return data
}

export async function retryTaxonomy(recordId: number): Promise<WorkflowDetail> {
  const { data } = await api.post<WorkflowDetail>(
    `/workflows/${recordId}/retry-taxonomy`,
    null,
    { timeout: 130_000 },
  )
  return data
}

export async function commitWorkflow(
  recordId: number,
  body: CommitWorkflowRequest,
): Promise<CommitWorkflowResponse> {
  const { data } = await api.post<CommitWorkflowResponse>(
    `/workflows/${recordId}/commit`,
    body,
    { timeout: 130_000 },
  )
  return data
}
