import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Upload, ZoomIn, ZoomOut, RotateCw, RotateCcw, Loader2,
  CheckCircle, AlertCircle, RefreshCw, Trash2, Lock, Image as ImageIcon,
  ListStart, SkipForward,
} from 'lucide-react'
import { useToast } from '@/components/Toast'
import Loading from '@/components/Loading'
import { extractImage, reExtract, confirmExtraction } from '@/services/recognition'
import { getActiveDraft, discardDraft, imageUrl } from '@/services/draft'
import {
  extractNextMaterial,
  getMaterialSummary,
  getPrefetchStatus,
  skipMaterial,
} from '@/services/materials'
import type { MaterialPrefetchStatus } from '@/types'
import { extractErrorMessage } from '@/types'
import {
  STATUS, ACTIVE_DRAFT_STATUSES, STATUS_LABELS, STATUS_COLORS,
  CONFIDENCE_LABELS, CONFIDENCE_COLORS,
  IMAGE_FIELDS,
} from '@/lib/status'
import type { MaterialSummary, RecordDetail } from '@/types'
import ExcelPreview from '@/components/ExcelPreview'
import AuthenticatedImage from '@/components/AuthenticatedImage'

interface DraftData {
  recordId: number
  status: string
  imageFilename: string
  imagePath: string
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
  const [materialSummary, setMaterialSummary] = useState<MaterialSummary | null>(null)
  const [queueLoading, setQueueLoading] = useState(false)
  const [skipping, setSkipping] = useState(false)
  const [prefetchStatus, setPrefetchStatus] = useState<MaterialPrefetchStatus | null>(null)
  const [localImageUrl, setLocalImageUrl] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

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

  const loadDraft = async () => {
    setLoading(true)
    try {
      const [detail, summary] = await Promise.all([
        getActiveDraft(),
        getMaterialSummary().catch(() => null),
      ])
      setMaterialSummary(summary)
      if (detail && ACTIVE_DRAFT_STATUSES.includes(detail.status as never)) {
        const draftData = parseDetailToDraft(detail)
        setDraft(draftData)
        setRotation(draftData.rotation)
        show('已恢复未完成的草稿', 'info')
      }
    } catch {
      // 静默忽略
    } finally {
      setLoading(false)
    }
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
      rotation: detail.rotation_degrees,
      extracted,
      confidence,
      warnings,
      materialItemId: detail.material_item_id,
      materialBatchId: detail.material_batch_id,
    }
  }

  // 上传图片
  const handleFileSelect = async (file: File) => {
    // 如果已有活跃草稿,弹窗确认
    if (draft && ACTIVE_DRAFT_STATUSES.includes(draft.status as never)) {
      setPendingFile(file)
      setShowDiscardDialog(true)
      return
    }
    await startExtraction(file, 0)
  }

  const startExtraction = async (file: File, rot: number) => {
    setExtracting(true)
    setOriginalFile(file)
    try {
      const result = await extractImage(file, rot)
      setDraft({
        recordId: result.record_id,
        status: result.status,
        imageFilename: file.name,
        imagePath: '',
        rotation: rot,
        extracted: result.extracted,
        confidence: result.confidence,
        warnings: result.warnings,
      })
      // 需要获取 image_path,重新拉取草稿
      const detail = await getActiveDraft()
      if (detail) {
        setDraft(prev => prev ? { ...prev, imagePath: detail.image_path } : prev)
      }
      show('图片信息提取完成,请核查确认', 'success')
    } catch (e) {
      show(extractErrorMessage(e, '图片识别失败'), 'error')
      setDraft(null)
      setOriginalFile(null)
    } finally {
      setExtracting(false)
    }
  }

  const startNextMaterial = async () => {
    setQueueLoading(true)
    setExtracting(true)
    try {
      const result = await extractNextMaterial()
      setDraft({
        recordId: result.record_id,
        status: result.status,
        imageFilename: result.original_filename,
        imagePath: '',
        rotation: 0,
        extracted: result.extracted,
        confidence: result.confidence,
        warnings: result.warnings,
        materialItemId: result.material_item_id,
        materialBatchId: result.batch_id,
      })
      setOriginalFile(null)
      setZoom(1)
      setRotation(0)
      const [detail, summary] = await Promise.all([
        getActiveDraft(),
        getMaterialSummary(),
      ])
      if (detail) {
        setDraft(parseDetailToDraft(detail))
      }
      setMaterialSummary(summary)
      show('素材图片识别完成,请核查确认', 'success')
    } catch (e) {
      show(extractErrorMessage(e, '加载下一张素材失败'), 'error')
      await loadDraft()
    } finally {
      setQueueLoading(false)
      setExtracting(false)
    }
    refreshPrefetchStatus()
  }

  const handleReExtract = async () => {
    if (!draft) return
    setExtracting(true)
    try {
      const result = await reExtract(draft.recordId)
      setDraft(prev => prev ? {
        ...prev,
        status: result.status,
        extracted: result.extracted,
        confidence: result.confidence,
        warnings: result.warnings,
      } : null)
      show('重新识别完成', 'success')
    } catch (e) {
      show(extractErrorMessage(e, '重新识别失败'), 'error')
    } finally {
      setExtracting(false)
    }
  }

  const finishCompletedRecord = async (excelRow: number, message: string) => {
    show(message, 'success')
    setHighlightRow(excelRow)
    setDraft(prev => prev ? { ...prev, status: STATUS.COMPLETED } : null)
    if (!draft?.materialItemId) {
      setTimeout(() => clearWorkbench(), 2000)
      return
    }

    try {
      const summary = await getMaterialSummary()
      setMaterialSummary(summary)
      clearWorkbench()
      setHighlightRow(excelRow)
      if (summary.pending_count > 0) {
        await startNextMaterial()
      } else {
        show('当前素材包已处理完毕', 'success')
      }
    } catch {
      clearWorkbench()
      setHighlightRow(excelRow)
      show('记录已完成,但素材进度刷新失败', 'error')
    }
  }

  const handleConfirm = async () => {
    if (!draft) return
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
      if (result.status === STATUS.COMPLETED) {
        await finishCompletedRecord(
          result.excel_row,
          `已写入 Excel 第 ${result.excel_row} 行`,
        )
      } else if (result.status === STATUS.CLASSIFICATION_FAILED) {
        show('分类校验失败,可在记录管理中重试分类', 'error')
        setDraft(prev => prev ? { ...prev, status: result.status } : null)
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
    setZoom(1)
    setRotation(0)
    setHighlightRow(null)
    fileRef.current?.focus()
  }

  const handleClear = () => {
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
    ) return
    setSkipping(true)
    try {
      const summary = await skipMaterial(draft.materialItemId)
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
    setDraft(prev => prev ? {
      ...prev,
      extracted: { ...prev.extracted, [field]: value },
    } : null)
  }

  const zhongmingEmpty = !draft?.extracted['中名']?.trim()
  const tuxiangEmpty = !draft?.extracted['图像']?.trim()
  const canConfirm = draft?.status === STATUS.AWAITING_CONFIRMATION && !zhongmingEmpty && !tuxiangEmpty && !confirming

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
            {!draft && !extracting && (
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
                      disabled={queueLoading}
                      className="flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {queueLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <ListStart className="h-4 w-4" />
                      )}
                      开始处理下一张素材
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

            {extracting && (
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="h-10 w-10 animate-spin text-blue-500" />
                <p className="text-sm text-blue-600">正在提取图片信息...</p>
              </div>
            )}

            {draft && !extracting && (
              <div className="relative flex h-full w-full items-center justify-center overflow-auto">
                <AuthenticatedImage
                  src={draft.imagePath ? imageUrl(draft.imagePath) : ''}
                  fallbackSrc={localImageUrl}
                  alt="标本图片"
                  className="max-h-full max-w-full object-contain transition-transform"
                  style={{
                    transform: `scale(${zoom}) rotate(${rotation}deg)`,
                  }}
                />
              </div>
            )}

            <input
              ref={fileRef}
              type="file"
              accept=".jpg,.jpeg,.png,.webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) handleFileSelect(f)
                e.target.value = ''
              }}
            />
          </div>

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
                <div className="mx-1 h-4 w-px bg-gray-200" />
                <button
                  onClick={() => handleRotate('ccw')}
                  className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
                  title="逆时针旋转"
                >
                  <RotateCcw className="h-4 w-4" />
                </button>
                <button
                  onClick={() => handleRotate('cw')}
                  className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
                  title="顺时针旋转"
                >
                  <RotateCw className="h-4 w-4" />
                </button>
                <div className="mx-1 h-4 w-px bg-gray-200" />
                <button
                  onClick={() => { setZoom(1); setRotation(0) }}
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
                  disabled={draft.status === STATUS.COMPLETED}
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
                        disabled={draft.status !== STATUS.AWAITING_CONFIRMATION && draft.status !== STATUS.EXTRACTION_FAILED}
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
                      <><Loader2 className="h-4 w-4 animate-spin" /> 正在整理分类信息...</>
                    ) : (
                      <><CheckCircle className="h-4 w-4" /> 确认信息并自动入表</>
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

                {/* 分类失败提示 */}
                {draft.status === STATUS.CLASSIFICATION_FAILED && (
                  <div className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                    <AlertCircle className="h-4 w-4" />
                    分类校验失败,可在"记录管理"中重新分类
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

          {/* 卡片2:分类信息(锁定) */}
          <div className="rounded-xl border border-gray-200 bg-white p-4 opacity-60">
            <div className="mb-3 flex items-center gap-2">
              <Lock className="h-4 w-4 text-gray-400" />
              <h3 className="text-sm font-semibold text-gray-700">分类信息</h3>
              {!draft || draft.status !== STATUS.COMPLETED ? (
                <span className="text-xs text-gray-400">
                  {!draft ? '请先上传图片' :
                   draft.status === STATUS.AWAITING_CONFIRMATION ? '请先确认图片信息' :
                   draft.status === STATUS.CLASSIFYING ? '正在整理...' :
                   '待分类完成后显示'}
                </span>
              ) : null}
            </div>
            <p className="text-center text-xs text-gray-400">
              分类信息将在确认图片信息后自动生成
            </p>
          </div>
        </div>
      </div>

      {/* Excel 实时预览区 */}
      <div className="shrink-0" style={{ height: 'clamp(310px, 35vh, 450px)' }}>
        <ExcelPreview
          draftRow={draft?.status === STATUS.AWAITING_CONFIRMATION ? draft.extracted : null}
          highlightRow={highlightRow}
        />
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
                onClick={async () => {
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
