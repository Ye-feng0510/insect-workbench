import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import Loading from '@/components/Loading'
import { useToast } from '@/components/Toast'
import AgentWorkbenchView, {
  type InspectorTab,
} from '@/features/workbench/AgentWorkbenchView'
import { discardDraft, getActiveDraft } from '@/services/draft'
import {
  extractNextMaterial,
  getMaterialSummary,
  getNextPreview,
  listMaterialItems,
  skipMaterial,
} from '@/services/materials'
import { extractImage, reExtract } from '@/services/recognition'
import {
  commitWorkflow,
  getActiveWorkflow,
  getWorkflow,
  postWorkflowMessage,
  resolveTaxonomy,
  retryTaxonomy,
  type TaxonomySource,
  type WorkflowDetail,
  type WorkflowMessage,
} from '@/services/workflows'
import {
  ACTIVE_DRAFT_STATUSES,
  IMAGE_FIELDS,
  STATUS,
  TAXONOMY_FIELDS,
} from '@/lib/status'
import type {
  MaterialItemInfo,
  MaterialPreview,
  MaterialSummary,
  RecordDetail,
} from '@/types'
import { extractErrorMessage } from '@/types'

const RECOGNITION_FIELDS = [...IMAGE_FIELDS, '鉴定人', '标签学名', '命名人']
const TAXONOMY_INPUT_FIELDS = new Set(['中名', '标签学名', '命名人'])

interface DraftData {
  recordId: number
  status: string
  imageFilename: string
  imageUrl: string
  rotation: number
  extracted: Record<string, string>
  confidence: Record<string, string>
  evidence: Record<string, string>
  warnings: string[]
  materialItemId?: number
  materialBatchId?: number
}

interface TaxonomyView {
  fields: Record<string, string>
  internal: Record<string, string>
  verification: string
  provenance: string
  sources: TaxonomySource[]
  warnings: string[]
  conflicts: string[]
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asString(value: unknown): string {
  return typeof value === 'string'
    ? value
    : value === null || value === undefined
      ? ''
      : String(value)
}

function stringRecord(value: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(asObject(value))) {
    if (typeof item === 'string' || typeof item === 'number') {
      result[key] = String(item)
    }
  }
  return result
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(asString).filter(Boolean)
}

function formatProvenanceValue(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} 个候选`
  if (value && typeof value === 'object') return JSON.stringify(value)
  return asString(value)
}

function workflowRecord(workflow: WorkflowDetail): Record<string, unknown> {
  return asObject(workflow.record)
}

function workflowRecordId(workflow: WorkflowDetail): number | undefined {
  const record = workflowRecord(workflow)
  const value = workflow.record_id ?? workflow.id ?? record.id
  return typeof value === 'number' ? value : Number(value) || undefined
}

function recognitionFromWorkflow(workflow: WorkflowDetail): Record<string, string> {
  const record = workflowRecord(workflow)
  const recognition = asObject(workflow.recognition)
  const extractedDraft = asObject(record.extracted_draft)
  const confirmedExtraction = asObject(record.confirmed_extraction)
  const candidates = [
    record.fields,
    workflow.fields,
    extractedDraft.extracted,
    workflow.extracted,
    recognition.fields,
    record.confirmed_extraction,
    recognition.confirmed,
    workflow.confirmed,
    confirmedExtraction.confirmed,
  ]
  const merged = Object.assign({}, ...candidates.map(stringRecord))
  const result = Object.fromEntries(
    RECOGNITION_FIELDS.map((field) => [field, merged[field] ?? '']),
  )
  return {
    ...result,
    标签学名: result['标签学名']
      || stringRecord(record.fields)['标签学名']
      || asString(workflow.scientific_name)
      || '',
    命名人: result['命名人']
      || stringRecord(record.fields)['命名人']
      || asString(workflow.scientific_name_authorship)
      || '',
  }
}

function taxonomyFromWorkflow(workflow: WorkflowDetail): TaxonomyView {
  const taxonomy = asObject(workflow.taxonomy)
  const workflowResolution = asObject(workflow.resolution)
  const proposal = {
    ...stringRecord(workflow.taxonomy_proposal),
    ...stringRecord(taxonomy.proposal),
    ...stringRecord(workflowResolution.proposal),
  }
  const resolution = {
    ...stringRecord(workflow.taxonomy_resolution),
    ...stringRecord(taxonomy.resolution),
  }
  const direct = stringRecord(taxonomy)
  const fields: Record<string, string> = {}
  for (const field of TAXONOMY_FIELDS) {
    fields[field] = resolution[field] ?? proposal[field] ?? direct[field] ?? ''
  }
  const internalSource = {
    ...stringRecord(taxonomy.internal),
    ...stringRecord(taxonomy.internal_taxonomy),
    ...proposal,
    ...resolution,
  }
  const lineage = stringRecord(workflowResolution.lineage)
  const internal: Record<string, string> = {
    亚科: asString(workflow.subfamily)
      || internalSource['亚科']
      || lineage.subfamily
      || '',
    族: asString(workflow.tribe)
      || internalSource['族']
      || lineage.tribe
      || '',
    亚属: asString(workflow.subgenus)
      || internalSource['亚属']
      || lineage.subgenus
      || '',
  }

  const verificationValue = (
    workflow.verification_status
    ?? taxonomy.verification_status
    ?? workflowResolution.verification_level
    ?? workflow.verification
    ?? taxonomy.verification
  )
  const verificationObject = asObject(verificationValue)
  const rawVerification = asString(
    typeof verificationValue === 'string'
      ? verificationValue
      : verificationObject.status,
  ) || 'unresolved'
  const verification = rawVerification === 'authoritative_match'
    ? 'verified'
    : rawVerification === 'unverified'
      ? 'unresolved'
      : rawVerification
  const provenanceValue = (
    workflowResolution.provenance
    ?? taxonomy.provenance
    ?? workflow.provenance
  )
  const provenanceObject = asObject(provenanceValue)
  const provenance = typeof provenanceValue === 'string'
    ? provenanceValue
    : asString(provenanceObject.summary)
      || (Object.keys(provenanceObject).length > 0
        ? Object.entries(provenanceObject)
          .filter(([key, value]) => key !== 'source_url' && Boolean(value))
          .map(([key, value]) => `${key}: ${formatProvenanceValue(value)}`)
          .join('；')
        : '')
  const sourceValue = taxonomy.sources ?? workflow.sources
  const sources: TaxonomySource[] = Array.isArray(sourceValue)
    ? sourceValue.filter((item): item is TaxonomySource => (
      Boolean(item) && typeof item === 'object'
    ))
    : []
  const provenanceUrl = asString(provenanceObject.source_url)
  if (provenanceUrl) {
    sources.push({
      title: asString(provenanceObject.provider)
        || asString(workflowResolution.source)
        || '分类来源',
      url: provenanceUrl,
    })
  }
  return {
    fields,
    internal,
    verification,
    provenance,
    sources,
    warnings: [
      ...stringArray(workflow.warnings),
      ...stringArray(taxonomy.warnings),
    ],
    conflicts: [
      ...stringArray(workflow.conflicts),
      ...stringArray(taxonomy.conflicts),
      ...stringArray(workflowResolution.conflicts),
    ],
  }
}

function normalizeWorkflowMessages(value: unknown): WorkflowMessage[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const message = asObject(item)
    const content = message.content
    const text = typeof content === 'string'
      ? content
      : asString(asObject(content).text)
    if (!text) return []
    return [{
      id: typeof message.id === 'number' || typeof message.id === 'string'
        ? message.id
        : undefined,
      role: asString(message.role ?? message.actor) || 'assistant',
      content: text,
      created_at: asString(message.created_at) || undefined,
      kind: asString(message.kind ?? message.message_type) || undefined,
    }]
  })
}

function draftFromWorkflow(workflow: WorkflowDetail): DraftData | null {
  const record = workflowRecord(workflow)
  const recordId = workflowRecordId(workflow)
  if (!recordId) return null
  const recognition = asObject(workflow.recognition)
  const extractedDraft = asObject(record.extracted_draft)
  return {
    recordId,
    status: asString(workflow.status ?? workflow.state ?? record.status)
      || STATUS.AWAITING_CONFIRMATION,
    imageFilename: asString(
      workflow.image_filename ?? record.image_filename ?? record.original_filename,
    ) || '标本图片',
    imageUrl: asString(workflow.image_url ?? record.image_url),
    rotation: Number(workflow.rotation_degrees ?? record.rotation_degrees) || 0,
    extracted: recognitionFromWorkflow(workflow),
    confidence: stringRecord(
      recognition.confidence ?? extractedDraft.confidence ?? record.confidence,
    ),
    evidence: stringRecord(
      recognition.evidence ?? extractedDraft.evidence ?? record.evidence,
    ),
    warnings: [
      ...stringArray(record.warnings),
      ...stringArray(recognition.warnings),
    ],
    materialItemId: Number(
      workflow.material_item_id ?? record.material_item_id,
    ) || undefined,
    materialBatchId: Number(
      workflow.material_batch_id ?? record.material_batch_id,
    ) || undefined,
  }
}

function draftFromRecord(detail: RecordDetail): DraftData {
  const draft = asObject(detail.extracted_draft)
  const confirmed = asObject(detail.confirmed_extraction)
  return {
    recordId: detail.id,
    status: detail.status,
    imageFilename: detail.image_filename,
    imageUrl: detail.image_url,
    rotation: detail.rotation_degrees,
    extracted: {
      ...stringRecord(draft.extracted),
      ...stringRecord(detail.confirmed_extraction),
      ...stringRecord(confirmed.confirmed),
      鉴定人: detail.fields?.鉴定人 ?? '',
    },
    confidence: stringRecord(draft.confidence),
    evidence: stringRecord(draft.evidence),
    warnings: detail.warnings ?? [],
    materialItemId: detail.material_item_id,
    materialBatchId: detail.material_batch_id,
  }
}

export default function AIWorkbenchPage() {
  const { show } = useToast()
  const [loading, setLoading] = useState(true)
  const [extracting, setExtracting] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [sending, setSending] = useState(false)
  const [skipping, setSkipping] = useState(false)
  const [draft, setDraft] = useState<DraftData | null>(null)
  const [workflow, setWorkflow] = useState<WorkflowDetail | null>(null)
  const [taxonomy, setTaxonomy] = useState<TaxonomyView | null>(null)
  const [messages, setMessages] = useState<WorkflowMessage[]>([])
  const [chatText, setChatText] = useState('')
  const [manualOverrideReason, setManualOverrideReason] = useState('')
  const [upstreamDirty, setUpstreamDirty] = useState(false)
  const [materials, setMaterials] = useState<MaterialItemInfo[]>([])
  const [materialSummary, setMaterialSummary] = useState<MaterialSummary | null>(null)
  const [nextPreview, setNextPreview] = useState<MaterialPreview | null>(null)
  const [originalFile, setOriginalFile] = useState<File | null>(null)
  const [localImageUrl, setLocalImageUrl] = useState('')
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [imageError, setImageError] = useState('')
  const [imageRetryKey, setImageRetryKey] = useState(0)
  const [highlightRow, setHighlightRow] = useState<number | null>(null)
  const [previewRevision, setPreviewRevision] = useState(0)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('image')
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [showDiscardDialog, setShowDiscardDialog] = useState(false)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const extractionLockRef = useRef(false)
  const resolutionLockRef = useRef(false)
  const editRevisionRef = useRef(0)
  const mountedRef = useRef(false)
  const generationRef = useRef(0)

  const isCurrentGeneration = useCallback((generation: number) => (
    mountedRef.current && generationRef.current === generation
  ), [])

  useEffect(() => {
    mountedRef.current = true
    generationRef.current += 1
    return () => {
      mountedRef.current = false
      generationRef.current += 1
      extractionLockRef.current = false
      resolutionLockRef.current = false
    }
  }, [])

  const applyWorkflow = useCallback((value: WorkflowDetail | null) => {
    setWorkflow(value)
    if (!value) {
      setTaxonomy(null)
      setMessages([])
      return
    }
    const workflowDraft = draftFromWorkflow(value)
    if (workflowDraft) {
      setDraft((current) => ({
        ...workflowDraft,
        status: workflowDraft.status || current?.status || STATUS.AWAITING_CONFIRMATION,
        imageFilename: workflowDraft.imageFilename || current?.imageFilename || '标本图片',
        imageUrl: workflowDraft.imageUrl || current?.imageUrl || '',
        materialItemId: workflowDraft.materialItemId ?? current?.materialItemId,
        materialBatchId: workflowDraft.materialBatchId ?? current?.materialBatchId,
        extracted: {
          ...(current?.extracted ?? {}),
          ...workflowDraft.extracted,
        },
        confidence: Object.keys(workflowDraft.confidence).length > 0
          ? workflowDraft.confidence
          : current?.confidence ?? {},
        evidence: Object.keys(workflowDraft.evidence).length > 0
          ? workflowDraft.evidence
          : current?.evidence ?? {},
      }))
      setRotation(workflowDraft.rotation)
    }
    const nextTaxonomy = taxonomyFromWorkflow(value)
    const hasTaxonomy = (
      Object.values(nextTaxonomy.fields).some(Boolean)
      || Object.values(nextTaxonomy.internal).some(Boolean)
      || nextTaxonomy.sources.length > 0
      || nextTaxonomy.provenance
      || nextTaxonomy.verification !== 'unresolved'
      || Boolean(value.taxonomy)
      || Boolean(value.taxonomy_proposal)
      || Boolean(value.resolution)
    )
    setTaxonomy(hasTaxonomy ? nextTaxonomy : null)
    setMessages(normalizeWorkflowMessages(value.messages))
    setUpstreamDirty(false)
  }, [])

  const refreshMaterials = useCallback(async () => {
    const generation = generationRef.current
    const [summaryResult, itemsResult] = await Promise.allSettled([
      getMaterialSummary(),
      listMaterialItems(undefined, 1000),
    ])
    if (!isCurrentGeneration(generation)) return
    if (summaryResult.status === 'fulfilled') {
      setMaterialSummary(summaryResult.value)
    }
    if (itemsResult.status === 'fulfilled') {
      setMaterials(itemsResult.value)
    }
  }, [isCurrentGeneration])

  const loadRecordWorkflow = useCallback(async (recordId: number) => {
    const generation = generationRef.current
    try {
      const value = await getWorkflow(recordId)
      if (!isCurrentGeneration(generation)) return null
      applyWorkflow(value)
      return value
    } catch {
      // The legacy draft remains usable if an older backend has no workflow API.
      return null
    }
  }, [applyWorkflow, isCurrentGeneration])

  const loadWorkbench = useCallback(async () => {
    const generation = generationRef.current
    setLoading(true)
    const [activeWorkflowResult, activeDraftResult] = await Promise.allSettled([
      getActiveWorkflow(),
      getActiveDraft(),
    ])
    if (!isCurrentGeneration(generation)) return
    if (
      activeWorkflowResult.status === 'fulfilled'
      && activeWorkflowResult.value
    ) {
      applyWorkflow(activeWorkflowResult.value)
      show('已恢复未完成的对话工作流', 'info')
    } else if (
      activeDraftResult.status === 'fulfilled'
      && activeDraftResult.value
      && ACTIVE_DRAFT_STATUSES.includes(activeDraftResult.value.status as never)
    ) {
      const restored = draftFromRecord(activeDraftResult.value)
      setDraft(restored)
      setRotation(restored.rotation)
      await loadRecordWorkflow(restored.recordId)
      if (!isCurrentGeneration(generation)) return
      show('已恢复未完成的草稿', 'info')
    }
    await refreshMaterials()
    if (!isCurrentGeneration(generation)) return
    setLoading(false)
  }, [
    applyWorkflow,
    isCurrentGeneration,
    loadRecordWorkflow,
    refreshMaterials,
    show,
  ])

  useEffect(() => {
    void loadWorkbench()
  }, [loadWorkbench])

  useEffect(() => {
    if (!originalFile) {
      setLocalImageUrl('')
      return
    }
    const url = URL.createObjectURL(originalFile)
    setLocalImageUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [originalFile])

  useEffect(() => {
    if (draft || !materialSummary?.batch || materialSummary.pending_count === 0) {
      setNextPreview(null)
      return
    }
    let active = true
    getNextPreview()
      .then((preview) => {
        if (active) {
          setNextPreview(preview)
          setImageError('')
        }
      })
      .catch((error) => {
        if (active) {
          setImageError(extractErrorMessage(error, '加载素材图片失败'))
        }
      })
    return () => {
      active = false
    }
  }, [draft, materialSummary?.batch, materialSummary?.pending_count])

  useEffect(() => {
    if (!materialSummary?.quota_exhausted) return
    const interval = setInterval(() => {
      void refreshMaterials()
    }, 5000)
    return () => clearInterval(interval)
  }, [materialSummary?.quota_exhausted, refreshMaterials])

  const clearWorkbench = useCallback(() => {
    setDraft(null)
    setWorkflow(null)
    setTaxonomy(null)
    setMessages([])
    setManualOverrideReason('')
    setOriginalFile(null)
    setImageError('')
    setZoom(1)
    setRotation(0)
    setUpstreamDirty(false)
    setInspectorTab('image')
    setInspectorOpen(false)
    fileRef.current?.focus()
  }, [])

  const createDraftFromExtract = (
    result: {
      record_id: number
      status: string
      image_url: string
      extracted: Record<string, string>
      confidence: Record<string, string>
      evidence: Record<string, string>
      warnings: string[]
    },
    imageFilename: string,
    rotationDegrees: number,
    materialItemId?: number,
    materialBatchId?: number,
  ) => {
    const value: DraftData = {
      recordId: result.record_id,
      status: result.status,
      imageFilename,
      imageUrl: result.image_url,
      rotation: rotationDegrees,
      extracted: result.extracted,
      confidence: result.confidence,
      evidence: result.evidence,
      warnings: result.warnings,
      materialItemId,
      materialBatchId,
    }
    setDraft(value)
    setWorkflow(null)
    setTaxonomy(null)
    setMessages([])
    setUpstreamDirty(false)
    setImageError('')
    setInspectorTab('image')
    return value
  }

  const startExtraction = async (file: File) => {
    if (extractionLockRef.current || resolutionLockRef.current) return
    const generation = generationRef.current
    extractionLockRef.current = true
    const selectedRotation = rotation
    setExtracting(true)
    setOriginalFile(file)
    try {
      const result = await extractImage(file, selectedRotation)
      if (!isCurrentGeneration(generation)) return
      createDraftFromExtract(result, file.name, selectedRotation)
      await loadRecordWorkflow(result.record_id)
      if (!isCurrentGeneration(generation)) return
      show('标签信息提取完成，请核查并确认', 'success')
    } catch (error) {
      if (!isCurrentGeneration(generation)) return
      show(extractErrorMessage(error, '图片识别失败'), 'error')
      clearWorkbench()
    } finally {
      if (isCurrentGeneration(generation)) {
        extractionLockRef.current = false
        setExtracting(false)
      }
    }
  }

  const startNextMaterial = useCallback(async () => {
    if (extractionLockRef.current || resolutionLockRef.current) return
    const generation = generationRef.current
    extractionLockRef.current = true
    const selectedRotation = rotation
    setExtracting(true)
    try {
      const result = await extractNextMaterial(selectedRotation)
      if (!isCurrentGeneration(generation)) return
      createDraftFromExtract(
        result,
        result.original_filename,
        selectedRotation,
        result.material_item_id,
        result.batch_id,
      )
      setOriginalFile(null)
      setNextPreview(null)
      setZoom(1)
      setRotation(selectedRotation)
      await loadRecordWorkflow(result.record_id)
      if (!isCurrentGeneration(generation)) return
      await refreshMaterials()
      if (!isCurrentGeneration(generation)) return
      show('素材图片识别完成，请核查并确认', 'success')
    } catch (error) {
      if (!isCurrentGeneration(generation)) return
      const status = (error as { response?: { status?: number } }).response?.status
      if (status === 429) {
        await refreshMaterials()
        if (!isCurrentGeneration(generation)) return
        show('工作流配额已用尽，当前素材和图片已保留', 'error')
      } else {
        show(extractErrorMessage(error, '加载下一张素材失败'), 'error')
      }
    } finally {
      if (isCurrentGeneration(generation)) {
        extractionLockRef.current = false
        setExtracting(false)
      }
    }
  }, [
    isCurrentGeneration,
    loadRecordWorkflow,
    refreshMaterials,
    rotation,
    show,
  ])

  const handleFileSelect = async (file: File) => {
    if (extractionLockRef.current || resolutionLockRef.current) return
    if (draft && draft.status !== STATUS.COMPLETED) {
      setPendingFile(file)
      setShowDiscardDialog(true)
      return
    }
    await startExtraction(file)
  }

  const updateRecognition = (field: string, value: string) => {
    if (extractionLockRef.current || resolutionLockRef.current) return
    editRevisionRef.current += 1
    setDraft((current) => current ? {
      ...current,
      extracted: { ...current.extracted, [field]: value },
    } : null)
    if (taxonomy && TAXONOMY_INPUT_FIELDS.has(field)) setUpstreamDirty(true)
  }

  const confirmedRecognition = (value: DraftData) => Object.fromEntries(
    RECOGNITION_FIELDS.map((field) => [field, value.extracted[field] ?? '']),
  )

  const handleResolve = async () => {
    if (
      !draft
      || extractionLockRef.current
      || resolutionLockRef.current
    ) return
    if (!draft.extracted['中名']?.trim() || !draft.extracted['图像']?.trim()) {
      show('中名和图像编号不能为空', 'error')
      return
    }
    const generation = generationRef.current
    resolutionLockRef.current = true
    const requestRevision = editRevisionRef.current
    setResolving(true)
    try {
      const value = await resolveTaxonomy(draft.recordId, {
        confirmed: confirmedRecognition(draft),
        scientific_name: draft.extracted['标签学名']?.trim() ?? '',
        authorship: draft.extracted['命名人']?.trim() ?? '',
      })
      if (!isCurrentGeneration(generation)) return
      if (editRevisionRef.current !== requestRevision) {
        show('标签已在查询期间修改，已忽略过期分类结果，请重新查询', 'info')
        return
      }
      applyWorkflow(value)
      if (!value.taxonomy && !value.taxonomy_proposal) {
        await loadRecordWorkflow(draft.recordId)
        if (!isCurrentGeneration(generation)) return
      }
      show('标签信息已确认，分类建议已生成', 'success')
    } catch (error) {
      if (!isCurrentGeneration(generation)) return
      show(extractErrorMessage(error, '分类解析失败'), 'error')
    } finally {
      if (isCurrentGeneration(generation)) {
        resolutionLockRef.current = false
        setResolving(false)
      }
    }
  }

  const handleRetryTaxonomy = async () => {
    if (
      !draft
      || extractionLockRef.current
      || resolutionLockRef.current
    ) return
    const generation = generationRef.current
    resolutionLockRef.current = true
    const requestRevision = editRevisionRef.current
    setResolving(true)
    try {
      let value: WorkflowDetail
      if (upstreamDirty) {
        value = await resolveTaxonomy(draft.recordId, {
          confirmed: confirmedRecognition(draft),
          scientific_name: draft.extracted['标签学名']?.trim() ?? '',
          authorship: draft.extracted['命名人']?.trim() ?? '',
        })
      } else {
        value = await retryTaxonomy(draft.recordId)
      }
      if (!isCurrentGeneration(generation)) return
      if (editRevisionRef.current !== requestRevision) {
        show('字段已在查询期间修改，已忽略过期分类结果，请重新查询', 'info')
        return
      }
      applyWorkflow(value)
      show('分类建议已重新运行', 'success')
    } catch (error) {
      if (!isCurrentGeneration(generation)) return
      show(extractErrorMessage(error, '重新运行分类失败'), 'error')
    } finally {
      if (isCurrentGeneration(generation)) {
        resolutionLockRef.current = false
        setResolving(false)
      }
    }
  }

  const handleReExtract = async () => {
    if (
      !draft
      || extractionLockRef.current
      || resolutionLockRef.current
    ) return
    const generation = generationRef.current
    const requestRevision = editRevisionRef.current
    extractionLockRef.current = true
    setExtracting(true)
    try {
      const result = await reExtract(draft.recordId, rotation)
      if (!isCurrentGeneration(generation)) return
      if (editRevisionRef.current !== requestRevision) {
        show('字段已在重新识别期间修改，已忽略过期识别结果', 'info')
        return
      }
      setDraft((current) => current ? {
        ...current,
        status: result.status,
        imageUrl: result.image_url,
        rotation,
        extracted: { ...current.extracted, ...result.extracted },
        confidence: result.confidence,
        evidence: result.evidence,
        warnings: result.warnings,
      } : null)
      setTaxonomy(null)
      setUpstreamDirty(false)
      await loadRecordWorkflow(draft.recordId)
      if (!isCurrentGeneration(generation)) return
      show('重新识别完成', 'success')
    } catch (error) {
      if (!isCurrentGeneration(generation)) return
      show(extractErrorMessage(error, '重新识别失败'), 'error')
    } finally {
      if (isCurrentGeneration(generation)) {
        extractionLockRef.current = false
        setExtracting(false)
      }
    }
  }

  const completeAndAdvance = async (excelRow: number) => {
    const generation = generationRef.current
    setHighlightRow(excelRow)
    setPreviewRevision((revision) => revision + 1)
    await refreshMaterials()
    if (!isCurrentGeneration(generation)) return
    const wasMaterial = Boolean(draft?.materialItemId)
    clearWorkbench()
    setHighlightRow(excelRow)
    if (!wasMaterial) return
    const summary = await getMaterialSummary().catch(() => null)
    if (!isCurrentGeneration(generation)) return
    if (summary) setMaterialSummary(summary)
    if (summary && summary.pending_count > 0) {
      await startNextMaterial()
    } else {
      show('当前素材包已处理完毕', 'success')
    }
  }

  const performCommit = async (duplicateAction?: string) => {
    if (
      !draft
      || !taxonomy
      || upstreamDirty
      || extractionLockRef.current
      || resolutionLockRef.current
    ) return
    const generation = generationRef.current
    const body = {
      expected_revision: Number(workflow?.revision),
      confirmed: confirmedRecognition(draft),
      taxonomy: { ...taxonomy.fields, ...taxonomy.internal },
      ...(duplicateAction ? { duplicate_action: duplicateAction } : {}),
      ...(manualOverrideReason.trim()
        ? { manual_override_reason: manualOverrideReason.trim() }
        : {}),
    }
    const result = await commitWorkflow(draft.recordId, body)
    if (!isCurrentGeneration(generation)) return
    const excelRow = Number(result.excel_row)
    if (!excelRow) {
      throw new Error('服务未返回写入行号')
    }
    show(
      duplicateAction
        ? `已覆盖并写入 Excel 第 ${excelRow} 行`
        : `已写入 Excel 第 ${excelRow} 行`,
      'success',
    )
    await completeAndAdvance(excelRow)
  }

  const handleCommit = async () => {
    if (
      !draft
      || !taxonomy
      || upstreamDirty
      || extractionLockRef.current
      || resolutionLockRef.current
    ) return
    const generation = generationRef.current
    setInspectorTab('excel')
    setInspectorOpen(true)
    setCommitting(true)
    try {
      await performCommit()
    } catch (error) {
      if (!isCurrentGeneration(generation)) return
      const response = (
        error as { response?: { status?: number; data?: { detail?: unknown } } }
      ).response
      if (response?.status === 409) {
        const detail = response.data?.detail
        const detailText = typeof detail === 'string'
          ? detail
          : JSON.stringify(detail ?? {})
        if (confirm(`检测到重复图像编号。\n${detailText}\n\n确定覆盖已有记录吗？`)) {
          try {
            await performCommit('replace')
          } catch (replaceError) {
            if (!isCurrentGeneration(generation)) return
            show(extractErrorMessage(replaceError, '覆盖写入失败'), 'error')
          }
        } else {
          show('已取消，当前工作流保留', 'info')
        }
      } else {
        show(extractErrorMessage(error, '确认入表失败'), 'error')
      }
    } finally {
      if (isCurrentGeneration(generation)) {
        setCommitting(false)
      }
    }
  }

  const handleSendMessage = async () => {
    const content = chatText.trim()
    if (!draft || !content || sending || extractionLockRef.current) return
    const generation = generationRef.current
    setSending(true)
    setChatText('')
    setMessages((current) => [
      ...current,
      { role: 'user', content, created_at: new Date().toISOString() },
    ])
    try {
      const response = await postWorkflowMessage(draft.recordId, content)
      if (!isCurrentGeneration(generation)) return
      if ('messages' in response && Array.isArray(response.messages)) {
        setMessages(normalizeWorkflowMessages(response.messages))
      } else if ('content' in response) {
        setMessages((current) => [
          ...current,
          ...normalizeWorkflowMessages([response]),
        ])
      } else {
        await loadRecordWorkflow(draft.recordId)
      }
    } catch (error) {
      if (!isCurrentGeneration(generation)) return
      show(extractErrorMessage(error, '发送消息失败'), 'error')
    } finally {
      if (isCurrentGeneration(generation)) {
        setSending(false)
      }
    }
  }

  const handleSkip = async () => {
    if (
      !draft?.materialItemId
      || extractionLockRef.current
      || resolutionLockRef.current
    ) return
    const generation = generationRef.current
    setSkipping(true)
    try {
      const summary = await skipMaterial(draft.materialItemId)
      if (!isCurrentGeneration(generation)) return
      setMaterialSummary(summary)
      await refreshMaterials()
      if (!isCurrentGeneration(generation)) return
      clearWorkbench()
      show('已跳过当前素材', 'info')
      if (summary.pending_count > 0) await startNextMaterial()
    } catch (error) {
      if (!isCurrentGeneration(generation)) return
      show(extractErrorMessage(error, '跳过素材失败'), 'error')
    } finally {
      if (isCurrentGeneration(generation)) {
        setSkipping(false)
      }
    }
  }

  const handleDiscard = async () => {
    if (
      !draft
      || extractionLockRef.current
      || resolutionLockRef.current
      || !confirm('确定放弃当前未完成的工作流吗？')
    ) return
    const generation = generationRef.current
    try {
      await discardDraft(draft.recordId)
      if (!isCurrentGeneration(generation)) return
      clearWorkbench()
      await refreshMaterials()
      if (!isCurrentGeneration(generation)) return
      show('已放弃当前工作流', 'info')
    } catch (error) {
      if (!isCurrentGeneration(generation)) return
      show(extractErrorMessage(error, '放弃工作流失败'), 'error')
    }
  }

  const displayedImageUrl = draft?.imageUrl || nextPreview?.image_url || ''
  const displayedImageName = draft?.imageFilename || nextPreview?.filename || '标本图片'
  const currentMaterialId = draft?.materialItemId ?? nextPreview?.item_id
  const recognitionReady = Boolean(
    draft?.extracted['中名']?.trim() && draft?.extracted['图像']?.trim(),
  )
  const workflowStage = asString(workflow?.stage ?? workflow?.state ?? workflow?.status)
  const draftExcelRow = useMemo(() => (
    draft ? { ...draft.extracted, ...(taxonomy?.fields ?? {}) } : null
  ), [draft, taxonomy])

  if (loading) return <Loading />

  return (
    <>
      <AgentWorkbenchView
        draft={draft}
        taxonomy={taxonomy}
        messages={messages}
        workflowStage={workflowStage}
        recognitionReady={recognitionReady}
        upstreamDirty={upstreamDirty}
        manualOverrideReason={manualOverrideReason}
        chatText={chatText}
        displayedImageUrl={displayedImageUrl}
        displayedImageName={displayedImageName}
        localImageUrl={localImageUrl}
        imageRetryKey={imageRetryKey}
        imageError={imageError}
        zoom={zoom}
        rotation={rotation}
        extracting={extracting}
        resolving={resolving}
        committing={committing}
        sending={sending}
        skipping={skipping}
        materials={materials}
        materialSummary={materialSummary}
        nextPreview={nextPreview}
        currentMaterialId={currentMaterialId}
        draftExcelRow={draftExcelRow}
        highlightRow={highlightRow}
        previewRevision={previewRevision}
        inspectorTab={inspectorTab}
        inspectorOpen={inspectorOpen}
        onInspectorTabChange={setInspectorTab}
        onInspectorOpenChange={setInspectorOpen}
        onChooseFile={() => {
          if (
            !extractionLockRef.current
            && !resolutionLockRef.current
          ) fileRef.current?.click()
        }}
        onDropFile={(file) => void handleFileSelect(file)}
        onStartNextMaterial={() => void startNextMaterial()}
        onRecognitionChange={updateRecognition}
        onResolve={() => void handleResolve()}
        onRetryTaxonomy={() => void handleRetryTaxonomy()}
        onTaxonomyChange={(field, value) => {
          if (extractionLockRef.current || resolutionLockRef.current) return
          editRevisionRef.current += 1
          setTaxonomy((current) => current ? {
            ...current,
            fields: { ...current.fields, [field]: value },
          } : current)
        }}
        onInternalTaxonomyChange={(field, value) => {
          if (extractionLockRef.current || resolutionLockRef.current) return
          editRevisionRef.current += 1
          setTaxonomy((current) => current ? {
            ...current,
            internal: { ...current.internal, [field]: value },
          } : current)
        }}
        onManualOverrideReasonChange={(value) => {
          if (extractionLockRef.current || resolutionLockRef.current) return
          editRevisionRef.current += 1
          setManualOverrideReason(value)
        }}
        onCommit={() => void handleCommit()}
        onChatTextChange={setChatText}
        onSendMessage={() => void handleSendMessage()}
        onZoomChange={setZoom}
        onRotationChange={setRotation}
        onImageError={setImageError}
        onImageRetry={() => {
          setImageError('')
          setImageRetryKey((key) => key + 1)
        }}
        onReExtract={() => void handleReExtract()}
        onSkip={() => void handleSkip()}
        onDiscard={() => void handleDiscard()}
        onRefreshMaterials={() => void refreshMaterials()}
      />
      <input
        ref={fileRef}
        type="file"
        accept=".jpg,.jpeg,.png,.webp"
        disabled={extracting || resolving}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void handleFileSelect(file)
          event.target.value = ''
        }}
      />
      {showDiscardDialog && pendingFile ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 backdrop-blur-sm">
          <div role="dialog" aria-modal="true" aria-labelledby="discard-title" className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <h3 id="discard-title" className="text-lg font-semibold text-slate-900">存在未完成的工作流</h3>
            <p className="my-3 text-sm leading-6 text-slate-500">上传新图片将放弃当前未提交的数据，确定继续吗？</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowDiscardDialog(false)
                  setPendingFile(null)
                }}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                继续当前工作流
              </button>
              <button
                type="button"
                disabled={extracting || resolving}
                onClick={async () => {
                  if (extractionLockRef.current || resolutionLockRef.current) return
                  const file = pendingFile
                  if (draft) await discardDraft(draft.recordId)
                  setShowDiscardDialog(false)
                  setPendingFile(null)
                  clearWorkbench()
                  await refreshMaterials()
                  await startExtraction(file)
                }}
                className="rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                放弃并上传
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}