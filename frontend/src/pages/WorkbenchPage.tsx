import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Upload, ZoomIn, ZoomOut, RotateCw, RotateCcw, Loader2,
  CheckCircle, AlertCircle, RefreshCw, Trash2, Image as ImageIcon,
  ListStart, SkipForward, ChevronDown, ChevronUp,
} from 'lucide-react'
import { useToast } from '@/components/Toast'
import Loading from '@/components/Loading'
import { extractImage, reExtract, confirmExtraction } from '@/services/recognition'
import { getActiveDraft, discardDraft } from '@/services/draft'
import {
  extractNextMaterial,
  getMaterialSummary,
  getNextPreview,
  getPrefetchStatus,
  skipMaterial,
  activateClassicWorkbench,
  deactivateClassicWorkbench,
} from '@/services/materials'
import type { MaterialPrefetchStatus, MaterialPreview } from '@/types'
import { extractErrorMessage } from '@/types'
import {
  STATUS, ACTIVE_DRAFT_STATUSES, STATUS_LABELS, STATUS_COLORS,
  CONFIDENCE_LABELS, CONFIDENCE_COLORS,
  IMAGE_FIELDS, MANUAL_OPTIONAL_FIELDS,
} from '@/lib/status'
import type { MaterialSummary, RecordDetail } from '@/types'
import ExcelPreview from '@/components/ExcelPreview'
import AuthenticatedImage from '@/components/AuthenticatedImage'
import { originalAssetUrl, previewAssetUrl } from '@/services/assets'

interface DraftData {
  recordId: number
  status: string
  imageFilename: string
  imagePath: string
  imageUrl: string
  rotation: number
  extracted: Record<string, string>
  confidence: Record<string, string>
  warnings: string[]
  materialItemId?: number
  materialBatchId?: number
}

export default function WorkbenchPage() {
  const { show } = useToast()
  const [loading, setLoading] = useState(true)
  const [extracting, setExtracting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [draft, setDraft] = useState<DraftData | null>(null)
  const [originalFile, setOriginalFile] = useState<File | null>(null)
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [showDiscardDialog, setShowDiscardDialog] = useState(false)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [highlightRow, setHighlightRow] = useState<number | null>(null)
  const [previewRevision, setPreviewRevision] = useState(0)
  const [materialSummary, setMaterialSummary] = useState<MaterialSummary | null>(null)
  const [nextMaterialPreview, setNextMaterialPreview] = useState<MaterialPreview | null>(null)
  const [imageError, setImageError] = useState('')
  const [imageRetryKey, setImageRetryKey] = useState(0)
  const [queueLoading, setQueueLoading] = useState(false)
  const [skipping, setSkipping] = useState(false)
  const [prefetchStatus, setPrefetchStatus] = useState<MaterialPrefetchStatus | null>(null)
  const [localImageUrl, setLocalImageUrl] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [showOriginalImage, setShowOriginalImage] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const extractionLockRef = useRef(false)
  const editRevisionRef = useRef(0)
  const mountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    void activateClassicWorkbench()
    const heartbeat = window.setInterval(() => {
      void activateClassicWorkbench()
    }, 60_000)
    return () => {
      window.clearInterval(heartbeat)
      void deactivateClassicWorkbench()
      mountedRef.current = false
      extractionLockRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!originalFile) {
      setLocalImageUrl('')
      return
    }
    const url = URL.createObjectURL(originalFile)
    setLocalImageUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [originalFile])

  // 定期轮询预加载状态
  const refreshPrefetchStatusCb = useCallback(async () => {
    try {
      setPrefetchStatus(await getPrefetchStatus())
    } catch {
      setPrefetchStatus(null)
    }
  }, [])

  useEffect(() => {
    loadDraft()
    const interval = setInterval(refreshPrefetchStatusCb, 3000)
    return () => clearInterval(interval)
  }, [refreshPrefetchStatusCb])

  useEffect(() => {
    if (
      draft
      || !materialSummary?.batch
      || materialSummary.pending_count === 0
    ) {
      setNextMaterialPreview(null)
      return
    }
    let active = true
    getNextPreview()
      .then((preview) => {
        if (active) {
          setNextMaterialPreview(preview)
          setImageError('')
        }
      })
      .catch((error) => {
        if (active) {
          setNextMaterialPreview(null)
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
      getMaterialSummary()
        .then(setMaterialSummary)
        .catch(() => undefined)
    }, 5000)
    return () => clearInterval(interval)
  }, [materialSummary?.quota_exhausted])

  const loadDraft = async () => {
    setLoading(true)
    const [detailResult, summaryResult] = await Promise.allSettled([
      getActiveDraft(),
      getMaterialSummary(),
    ])
    if (summaryResult.status === 'fulfilled') {
      setMaterialSummary(summaryResult.value)
    }
    if (detailResult.status === 'fulfilled') {
      const detail = detailResult.value
      if (detail && ACTIVE_DRAFT_STATUSES.includes(detail.status as never)) {
        const draftData = parseDetailToDraft(detail)
        setDraft(draftData)
        setRotation(draftData.rotation)
        setImageError('')
        show('已恢复未完成的草稿', 'info')
      }
    }
    setLoading(false)
    refreshPrefetchStatus()
  }

  const refreshPrefetchStatus = async () => {
    await refreshPrefetchStatusCb()
  }

  const parseDetailToDraft = (detail: RecordDetail): DraftData => {
    const extracted = (detail.extracted_draft as Record<string, unknown>)?.extracted as Record<string, string> ?? {}
    const confidence = (detail.extracted_draft as Record<string, unknown>)?.confidence as Record<string, string> ?? {}
    const warnings = detail.warnings ?? []
    return {
      recordId: detail.id,
      status: detail.status,
      imageFilename: detail.image_filename,
      imagePath: detail.image_path,
      imageUrl: previewAssetUrl(detail.image_url),
      rotation: detail.rotation_degrees,
      extracted: {
        ...extracted,
        鉴定人: detail.fields?.鉴定人 ?? '',
      },
      confidence,
      warnings,
      materialItemId: detail.material_item_id,
      materialBatchId: detail.material_batch_id,
    }
  }

  const handleImageLoadError = useCallback((message: string) => {
    setImageError(message)
  }, [])

  // 上传图片
  const handleFileSelect = async (file: File) => {
    if (extractionLockRef.current || confirming || skipping) return
    // 如果已有活跃草稿,弹窗确认
    if (draft && ACTIVE_DRAFT_STATUSES.includes(draft.status as never)) {
      setPendingFile(file)
      setShowDiscardDialog(true)
      return
    }
    await startExtraction(file, 0)
  }

  const startExtraction = async (file: File, rot: number) => {
    if (extractionLockRef.current) return
    extractionLockRef.current = true
    setExtracting(true)
    setOriginalFile(file)
    try {
      const result = await extractImage(file, rot)
      if (!mountedRef.current) return
      setDraft({
        recordId: result.record_id,
        status: result.status,
        imageFilename: file.name,
        imagePath: '',
        imageUrl: previewAssetUrl(result.image_url),
        rotation: rot,
        extracted: result.extracted,
        confidence: result.confidence,
        warnings: result.warnings,
      })
      setImageError('')
      show('图片信息提取完成,请核查确认', 'success')
    } catch (e) {
      if (!mountedRef.current) return
      show(extractErrorMessage(e, '图片识别失败'), 'error')
      setDraft(null)
      setOriginalFile(null)
    } finally {
      if (mountedRef.current) {
        extractionLockRef.current = false
        setExtracting(false)
      }
    }
  }

  const startNextMaterial = async () => {
    if (extractionLockRef.current) return
    extractionLockRef.current = true
    const selectedRotation = rotation
    setQueueLoading(true)
    setExtracting(true)
    setShowOriginalImage(false)
    try {
      const result = await extractNextMaterial(selectedRotation)
      if (!mountedRef.current) return
      setDraft({
        recordId: result.record_id,
        status: result.status,
        imageFilename: result.original_filename,
        imagePath: '',
        imageUrl: nextMaterialPreview?.item_id === result.material_item_id
          ? nextMaterialPreview.image_url
          : previewAssetUrl(result.image_url),
        rotation: selectedRotation,
        extracted: result.extracted,
        confidence: result.confidence,
        warnings: result.warnings,
        materialItemId: result.material_item_id,
        materialBatchId: result.batch_id,
      })
      setOriginalFile(null)
      setNextMaterialPreview(null)
      setImageError('')
      setZoom(1)
      setRotation(selectedRotation)
      show('素材图片识别完成,请核查确认', 'success')
    } catch (e) {
      if (!mountedRef.current) return
      const status = (e as { response?: { status?: number } }).response?.status
      if (status === 429) {
        setMaterialSummary(await getMaterialSummary().catch(() => materialSummary))
        show('工作流配额已用尽,当前素材和图片已保留', 'error')
      } else if (status === 404) {
        clearWorkbench()
        setMaterialSummary(await getMaterialSummary().catch(() => materialSummary))
        show('当前素材包已处理完毕', 'success')
      } else {
        show(extractErrorMessage(e, '加载下一张素材失败'), 'error')
        await loadDraft()
        if (!mountedRef.current) return
      }
    } finally {
      if (mountedRef.current) {
        extractionLockRef.current = false
        setQueueLoading(false)
        setExtracting(false)
      }
    }
    refreshPrefetchStatus()
  }

  const handleReExtract = async () => {
    if (!draft || extractionLockRef.current || confirming || skipping) return
    const requestRevision = editRevisionRef.current
    extractionLockRef.current = true
    setExtracting(true)
    setShowOriginalImage(false)
    try {
      const result = await reExtract(draft.recordId, rotation)
      if (!mountedRef.current) return
      if (editRevisionRef.current !== requestRevision) {
        show('字段已在重新识别期间修改，已忽略过期识别结果', 'info')
        return
      }
      setDraft(prev => prev ? {
        ...prev,
        status: result.status,
        imageUrl: previewAssetUrl(result.image_url),
        rotation,
        extracted: { ...prev.extracted, ...result.extracted },
        confidence: result.confidence,
        warnings: result.warnings,
      } : null)
      show('重新识别完成', 'success')
    } catch (e) {
      if (!mountedRef.current) return
      show(extractErrorMessage(e, '重新识别失败'), 'error')
    } finally {
      if (mountedRef.current) {
        extractionLockRef.current = false
        setExtracting(false)
      }
    }
  }

  const finishCompletedRecord = async (excelRow: number, message: string) => {
    show(message, 'success')
    setHighlightRow(excelRow)
    setPreviewRevision((revision) => revision + 1)
    setDraft(prev => prev ? { ...prev, status: STATUS.COMPLETED } : null)
    if (!draft?.materialItemId) {
      setTimeout(() => clearWorkbench(), 2000)
      return
    }

    clearWorkbench()
    void getMaterialSummary().then(setMaterialSummary).catch(() => undefined)
    await startNextMaterial()
  }

  const handleConfirm = async () => {
    if (!draft || extractionLockRef.current || skipping) return
    const zhongming = draft.extracted['中名']?.trim()
    const tuxiang = draft.extracted['图像']?.trim()
    if (!zhongming) {
      show('中名不能为空', 'error')
      return
    }
    if (!tuxiang) {
      show('图像编号不能为空', 'error')
      return
    }
    setConfirming(true)
    try {
      const result = await confirmExtraction(draft.recordId, draft.extracted)
      if (!mountedRef.current) return
      if (result.status === STATUS.COMPLETED) {
        await finishCompletedRecord(
          result.excel_row,
          `已写入 Excel 第 ${result.excel_row} 行`,
        )
      }
    } catch (e: unknown) {
      // 检查是否 409 重复编号
      const err = e as { response?: { status?: number; data?: { detail?: string } } }
      if (err.response?.status === 409) {
        const detailStr = err.response.data?.detail ?? ''
        try {
          const conflict = JSON.parse(detailStr)
          const choice = confirm(
            `图像编号 "${conflict.existing_summary.图像}" 已存在(当前记录: ${conflict.existing_summary.中名})。\n\n点击"确定"覆盖已有记录,点击"取消"保留当前草稿。`
          )
          if (choice) {
            // 用户选择覆盖,重新提交
            const result = await confirmExtraction(draft.recordId, draft.extracted, 'replace')
            if (!mountedRef.current) return
            if (result.status === STATUS.COMPLETED) {
              await finishCompletedRecord(
                result.excel_row,
                `已覆盖并写入 Excel 第 ${result.excel_row} 行`,
              )
            }
          } else {
            show('已取消,当前草稿保留', 'info')
          }
        } catch {
          show('图像编号重复,请修改后重试', 'error')
        }
      } else {
        show(extractErrorMessage(e, '确认入表失败'), 'error')
      }
    } finally {
      setConfirming(false)
    }
  }

  const clearWorkbench = () => {
    setDraft(null)
    setOriginalFile(null)
    setImageError('')
    setZoom(1)
    setRotation(0)
    setHighlightRow(null)
    setShowOriginalImage(false)
    fileRef.current?.focus()
  }

  const handleClear = () => {
    if (extractionLockRef.current || confirming || skipping) return
    if (!draft) {
      clearWorkbench()
      return
    }
    if (draft.status === STATUS.COMPLETED) return
    if (!confirm('确定清空当前图片?未确认的草稿将被放弃。')) return
    discardDraft(draft.recordId).then(async () => {
      setMaterialSummary(await getMaterialSummary().catch(() => materialSummary))
      clearWorkbench()
      show('已清空', 'info')
    })
  }

  const handleSkipMaterial = async () => {
    if (
      !draft?.materialItemId
      || draft.status === STATUS.COMPLETED
      || skipping
      || extracting
      || extractionLockRef.current
    ) return
    setSkipping(true)
    try {
      const summary = await skipMaterial(draft.materialItemId)
      if (!mountedRef.current) return
      setMaterialSummary(summary)
      clearWorkbench()
      show('已跳过当前素材', 'info')
      if (summary.pending_count > 0) {
        await startNextMaterial()
      } else {
        show('当前素材包已处理完毕', 'success')
      }
    } catch (e) {
      show(extractErrorMessage(e, '跳过素材失败'), 'error')
    } finally {
      setSkipping(false)
    }
    refreshPrefetchStatus()
  }

  const handleRotate = (dir: 'cw' | 'ccw') => {
    setRotation(prev => {
      const next = dir === 'cw' ? (prev + 90) % 360 : (prev - 90 + 360) % 360
      return next
    })
  }

  // 更新字段
  const updateField = (field: string, value: string) => {
    if (extractionLockRef.current || confirming || skipping) return
    editRevisionRef.current += 1
    setDraft(prev => prev ? {
      ...prev,
      extracted: { ...prev.extracted, [field]: value },
    } : null)
  }

  const zhongmingEmpty = !draft?.extracted['中名']?.trim()
  const tuxiangEmpty = !draft?.extracted['图像']?.trim()
  const canConfirm = draft?.status === STATUS.AWAITING_CONFIRMATION && !zhongmingEmpty && !tuxiangEmpty && !confirming && !extracting
  const displayedPreviewUrl = draft?.imageUrl || nextMaterialPreview?.image_url || ''
  const displayedImageUrl = showOriginalImage && draft
    ? originalAssetUrl(`/api/recognition/${draft.recordId}/image`)
    : displayedPreviewUrl
  const displayedImageName = draft?.imageFilename || nextMaterialPreview?.filename || '标本图片'

  if (loading) {
    return <Loading />
  }

  return (
    <div className="flex flex-col gap-4" style={{ height: 'calc(100vh - 48px)' }}>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-4">
        {/* 左侧:图片区 */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700">标本图片</h3>
            {draft && (
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[draft.status] ?? 'bg-gray-100'}`}>
                {STATUS_LABELS[draft.status] ?? draft.status}
              </span>
            )}
          </div>

          {/* 上传/预览区 */}
          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-gray-50">
            {!draft && !nextMaterialPreview && !extracting && (
              <div
                role="button"
                tabIndex={0}
                aria-label="上传标本图片"
                onClick={() => fileRef.current?.click()}
                onKeyDown={(event) => {
                  if (
                    event.target === event.currentTarget
                    && (event.key === 'Enter' || event.key === ' ')
                  ) {
                    event.preventDefault()
                    fileRef.current?.click()
                  }
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  const f = e.dataTransfer.files[0]
                  if (f) handleFileSelect(f)
                }}
                className="flex h-full w-full cursor-pointer flex-col items-center justify-center gap-3 border-2 border-dashed border-gray-300 rounded-lg transition-colors hover:border-emerald-400 hover:bg-emerald-50/30"
              >
                {materialSummary?.batch && materialSummary.pending_count > 0 ? (
                  <div
                    onClick={(event) => event.stopPropagation()}
                    className="mb-2 flex flex-col items-center gap-2 rounded-lg bg-emerald-50 px-6 py-3"
                  >
                    <div className="flex items-center gap-2 text-sm font-medium text-emerald-700">
                      <ListStart className="h-4 w-4" />
                      当前素材包还有 {materialSummary.pending_count} 张待处理
                    </div>
                    {prefetchStatus && prefetchStatus.ready_count > 0 && (
                      <div className="flex items-center gap-1 text-xs text-blue-600">
                        <Loader2 className="h-3 w-3" />
                        已预加载 {prefetchStatus.ready_count}/{prefetchStatus.target} 张
                      </div>
                    )}
                    {prefetchStatus && prefetchStatus.running_count > 0 && prefetchStatus.ready_count === 0 && (
                      <div className="flex items-center gap-1 text-xs text-blue-600">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        正在预加载...
                      </div>
                    )}
                    <button
                      onClick={startNextMaterial}
                      disabled={queueLoading || materialSummary.quota_exhausted}
                      className="flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {queueLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <ListStart className="h-4 w-4" />
                      )}
                      {materialSummary.quota_exhausted
                        ? '配额已用尽'
                        : '开始处理下一张素材'}
                    </button>
                  </div>
                ) : materialSummary?.batch && materialSummary.total_count > 0 ? (
                  <p className="rounded-lg bg-gray-100 px-4 py-2 text-xs text-gray-500">
                    当前素材包暂无待处理图片
                  </p>
                ) : null}
                <Upload className="h-10 w-10 text-emerald-500" />
                <p className="text-sm font-medium text-gray-600">点击或拖拽上传昆虫标本图片</p>
                <p className="text-xs text-gray-400">支持 JPG / JPEG / PNG / WebP</p>
              </div>
            )}

            {(draft || nextMaterialPreview) && (
              <div className="relative flex h-full w-full items-center justify-center overflow-auto">
                <AuthenticatedImage
                  key={`${displayedImageUrl}:${imageRetryKey}`}
                  src={displayedImageUrl}
                  fallbackSrc={draft ? localImageUrl : ''}
                  onLoadError={handleImageLoadError}
                  alt={displayedImageName}
                  className="max-h-full max-w-full object-contain transition-transform"
                  style={{
                    transform: `scale(${zoom}) rotate(${rotation}deg)`,
                  }}
                />
                {imageError && (
                  <div className="absolute inset-x-4 bottom-4 rounded-lg border border-red-200 bg-white/95 p-3 text-center shadow-sm">
                    <p className="text-xs text-red-600">
                      识别结果已保留,但图片读取失败: {imageError}
                    </p>
                    <button
                      onClick={() => {
                        setImageError('')
                        setImageRetryKey((key) => key + 1)
                      }}
                      className="mt-2 rounded-md border border-red-200 px-3 py-1 text-xs text-red-600 hover:bg-red-50"
                    >
                      重新加载图片
                    </button>
                  </div>
                )}
                {!draft && !extracting && (
                  <button
                    onClick={startNextMaterial}
                    disabled={queueLoading || materialSummary?.quota_exhausted}
                    className="absolute bottom-4 flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <ListStart className="h-4 w-4" />
                    开始识别这张素材
                  </button>
                )}
              </div>
            )}

            {extracting && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white/75">
                <Loader2 className="h-10 w-10 animate-spin text-blue-500" />
                <p className="text-sm text-blue-600">正在提取图片信息...</p>
              </div>
            )}

            <input
              ref={fileRef}
              type="file"
              accept=".jpg,.jpeg,.png,.webp"
              disabled={extracting || confirming || skipping}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) handleFileSelect(f)
                e.target.value = ''
              }}
            />
          </div>

          {materialSummary?.quota_exhausted && materialSummary.pending_count > 0 && (
            <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              工作流配额已用尽（已计费 {materialSummary.quota_charged}
              {materialSummary.quota_total === null ? '' : ` / ${materialSummary.quota_total}`}）。
              当前素材和图片已保留,管理员增加配额后可从本张继续处理。
            </div>
          )}

          {/* 图片控制工具栏 */}
          {draft && (
            <div className="mt-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setZoom(z => Math.max(0.25, z - 0.25))}
                  className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
                  title="缩小"
                >
                  <ZoomOut className="h-4 w-4" />
                </button>
                <span className="w-12 text-center text-xs text-gray-500">{Math.round(zoom * 100)}%</span>
                <button
                  onClick={() => setZoom(z => Math.min(4, z + 0.25))}
                  className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
                  title="放大"
                >
                  <ZoomIn className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setShowOriginalImage((current) => !current)}
                  className="rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
                  title="按需加载或关闭原图"
                >
                  {showOriginalImage ? '使用预览图' : '查看原图'}
                </button>
                <div className="mx-1 h-4 w-px bg-gray-200" />
                <button
                  onClick={() => handleRotate('ccw')}
                  disabled={extracting}
                  className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
                  title="逆时针旋转"
                >
                  <RotateCcw className="h-4 w-4" />
                </button>
                <button
                  onClick={() => handleRotate('cw')}
                  disabled={extracting}
                  className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
                  title="顺时针旋转"
                >
                  <RotateCw className="h-4 w-4" />
                </button>
                <div className="mx-1 h-4 w-px bg-gray-200" />
                <button
                  onClick={() => { setZoom(1); setRotation(0) }}
                  disabled={extracting}
                  className="rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
                >
                  重置
                </button>
              </div>
              <div className="flex items-center gap-2">
                {draft.status === STATUS.AWAITING_CONFIRMATION && (
                  <button
                    onClick={handleReExtract}
                    disabled={extracting}
                    className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    重新识别
                  </button>
                )}
                {draft.materialItemId && (
                  <button
                    onClick={handleSkipMaterial}
                    disabled={
                      draft.status === STATUS.COMPLETED
                      || skipping
                      || confirming
                      || extracting
                    }
                    className="flex items-center gap-1.5 rounded-md border border-amber-300 px-3 py-1.5 text-xs text-amber-600 hover:bg-amber-50 disabled:opacity-50"
                  >
                    {skipping ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <SkipForward className="h-3.5 w-3.5" />
                    )}
                    跳过当前素材
                  </button>
                )}
                <button
                  onClick={handleClear}
                  disabled={
                    draft.status === STATUS.COMPLETED
                    || extracting
                    || confirming
                    || skipping
                  }
                  className="flex items-center gap-1.5 rounded-md border border-red-200 px-3 py-1.5 text-xs text-red-500 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  清空
                </button>
              </div>
            </div>
          )}

          {draft && (
            <div className="mt-1 flex items-center gap-2 text-xs text-gray-400">
              <p className="min-w-0 flex-1 truncate">
                <ImageIcon className="mr-1 inline h-3 w-3" />
                {draft.imageFilename} (旋转 {rotation}°)
              </p>
              {draft.materialItemId ? (
                <span className="shrink-0 rounded bg-emerald-50 px-2 py-0.5 text-emerald-600">
                  素材队列
                </span>
              ) : null}
            </div>
          )}
        </div>

        {/* 右侧:信息确认 */}
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          {/* 卡片1:图片原始信息确认 */}
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="mb-3 flex items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-700">图片原始信息确认</h3>
              {draft && draft.status === STATUS.AWAITING_CONFIRMATION && (
                <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs text-yellow-700">待确认</span>
              )}
            </div>

            {!draft ? (
              <p className="py-8 text-center text-sm text-gray-400">请先上传图片并识别</p>
            ) : extracting ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
              </div>
            ) : (
              <div className="space-y-3">
                {IMAGE_FIELDS.map((field) => {
                  const isRequired = field === '中名' || field === '图像'
                  const value = draft.extracted[field] ?? ''
                  const isEmpty = !value.trim()
                  const conf = draft.confidence[field]
                  return (
                    <div key={field}>
                      <div className="mb-1 flex items-center justify-between">
                        <label className="text-xs font-medium text-gray-600">
                          {field}
                          {isRequired && <span className="ml-1 text-red-500">*</span>}
                          {!isRequired && field !== '采集人' && isEmpty && draft.status === STATUS.AWAITING_CONFIRMATION && (
                            <span className="ml-1 text-amber-500">(空值警告)</span>
                          )}
                        </label>
                        {conf && (
                          <span className={`text-xs ${CONFIDENCE_COLORS[conf] ?? 'text-gray-400'}`}>
                            置信度: {CONFIDENCE_LABELS[conf] ?? conf}
                          </span>
                        )}
                      </div>
                      <input
                        type={field === '采集日期' ? 'date' : 'text'}
                        value={value}
                        onChange={(e) => updateField(field, e.target.value)}
                        disabled={
                          extracting
                          || confirming
                          || skipping
                          || (
                            draft.status !== STATUS.AWAITING_CONFIRMATION
                            && draft.status !== STATUS.EXTRACTION_FAILED
                          )
                        }
                        className={`w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-1 ${
                          isRequired && isEmpty && draft.status === STATUS.AWAITING_CONFIRMATION
                            ? 'border-red-300 focus:border-red-500 focus:ring-red-500'
                            : !isRequired && isEmpty && draft.status === STATUS.AWAITING_CONFIRMATION
                              ? 'border-amber-300 focus:border-amber-500 focus:ring-amber-500'
                              : 'border-gray-300 focus:border-emerald-500 focus:ring-emerald-500'
                        } ${draft.status !== STATUS.AWAITING_CONFIRMATION && draft.status !== STATUS.EXTRACTION_FAILED ? 'bg-gray-50' : ''}`}
                      />
                      {isRequired && isEmpty && draft.status === STATUS.AWAITING_CONFIRMATION && (
                        <p className="mt-0.5 text-xs text-red-500">{field}不能为空</p>
                      )}
                    </div>
                  )
                })}

                {MANUAL_OPTIONAL_FIELDS.map((field) => (
                  <div key={field}>
                    <label className="mb-1 block text-xs font-medium text-gray-600">
                      {field}
                      <span className="ml-1 font-normal text-gray-400">(选填)</span>
                    </label>
                    <input
                      type="text"
                      maxLength={200}
                      value={draft.extracted[field] ?? ''}
                      onChange={(e) => updateField(field, e.target.value)}
                      disabled={
                        extracting
                        || confirming
                        || skipping
                        || (
                          draft.status !== STATUS.AWAITING_CONFIRMATION
                          && draft.status !== STATUS.EXTRACTION_FAILED
                        )
                      }
                      className={`w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 ${
                        draft.status !== STATUS.AWAITING_CONFIRMATION && draft.status !== STATUS.EXTRACTION_FAILED ? 'bg-gray-50' : ''
                      }`}
                    />
                  </div>
                ))}

                {/* 警告显示 */}
                {draft.warnings.length > 0 && (
                  <div className="rounded-lg bg-amber-50 p-2">
                    {draft.warnings.map((w, i) => (
                      <p key={i} className="flex items-start gap-1 text-xs text-amber-700">
                        <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                        {w}
                      </p>
                    ))}
                  </div>
                )}

                {/* 确认按钮 */}
                {draft.status === STATUS.AWAITING_CONFIRMATION && (
                  <button
                    onClick={handleConfirm}
                    disabled={!canConfirm}
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {confirming ? (
                      <><Loader2 className="h-4 w-4 animate-spin" /> 正在保存识别结果...</>
                    ) : (
                      <><CheckCircle className="h-4 w-4" /> 确认识别并入表</>
                    )}
                  </button>
                )}

                {/* 完成提示 */}
                {highlightRow && (
                  <div className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                    <CheckCircle className="h-4 w-4" />
                    已写入 Excel 第 <strong>{highlightRow}</strong> 行
                  </div>
                )}

                {/* 识别失败提示 */}
                {draft.status === STATUS.EXTRACTION_FAILED && (
                  <div className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                    <AlertCircle className="h-4 w-4" />
                    图片识别失败,请点击"重新识别"或检查模型配置
                  </div>
                )}
              </div>
            )}
          </div>

        </div>
      </div>

      <div className="shrink-0 rounded-xl border border-gray-200 bg-white">
        <button
          type="button"
          onClick={() => setPreviewOpen((open) => !open)}
          className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-gray-700"
        >
          Excel 实时预览（按需加载最近记录）
          {previewOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        {previewOpen ? (
          <div style={{ height: 'clamp(310px, 35vh, 450px)' }}>
            <ExcelPreview
              draftRow={draft?.status === STATUS.AWAITING_CONFIRMATION ? draft.extracted : null}
              highlightRow={highlightRow}
              refreshRevision={previewRevision}
            />
          </div>
        ) : null}
      </div>

      {/* 放弃草稿弹窗 */}
      {showDiscardDialog && pendingFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-96 rounded-xl bg-white p-6 shadow-xl">
            <h3 className="mb-2 text-lg font-semibold text-gray-800">存在未完成的草稿</h3>
            <p className="mb-4 text-sm text-gray-500">
              当前有未确认的图片识别草稿。上传新图片将放弃当前草稿,确定继续吗?
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setShowDiscardDialog(false)
                  setPendingFile(null)
                }}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
              >
                继续处理当前草稿
              </button>
              <button
                disabled={extracting || confirming || skipping}
                onClick={async () => {
                  if (extractionLockRef.current || confirming || skipping) return
                  if (draft) {
                    await discardDraft(draft.recordId)
                    setMaterialSummary(await getMaterialSummary().catch(() => materialSummary))
                  }
                  setShowDiscardDialog(false)
                  clearWorkbench()
                  await startExtraction(pendingFile, 0)
                  setPendingFile(null)
                }}
                className="rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600"
              >
                放弃草稿并上传
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
