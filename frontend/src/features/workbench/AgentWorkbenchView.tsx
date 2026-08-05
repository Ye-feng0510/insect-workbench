import {
  AlertCircle,
  BookOpen,
  Check,
  CheckCircle2,
  ExternalLink,
  FileSpreadsheet,
  Image as ImageIcon,
  Images,
  Loader2,
  Maximize2,
  MessageSquare,
  PanelRight,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Send,
  SkipForward,
  Sparkles,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type { ReactNode } from 'react'
import AuthenticatedImage from '@/components/AuthenticatedImage'
import ExcelPreview from '@/components/ExcelPreview'
import {
  CONFIDENCE_COLORS,
  CONFIDENCE_LABELS,
  STATUS_COLORS,
  STATUS_LABELS,
  TAXONOMY_FIELDS,
} from '@/lib/status'
import type { TaxonomySource, WorkflowMessage } from '@/services/workflows'
import type {
  MaterialItemInfo,
  MaterialPreview,
  MaterialSummary,
} from '@/types'

const RECOGNITION_FIELDS = [
  '中名',
  '图像',
  '产地3',
  '采集人',
  '采集日期',
  '鉴定人',
  '标签学名',
  '命名人',
]

const INTERNAL_TAXONOMY_FIELDS = ['亚科', '族', '亚属']

export type InspectorTab = 'image' | 'evidence' | 'materials' | 'excel'

export interface WorkbenchDraftView {
  recordId: number
  status: string
  imageFilename: string
  imageUrl: string
  extracted: Record<string, string>
  confidence: Record<string, string>
  evidence: Record<string, string>
  warnings: string[]
  materialItemId?: number
}

export interface WorkbenchTaxonomyView {
  fields: Record<string, string>
  internal: Record<string, string>
  verification: string
  provenance: string
  sources: TaxonomySource[]
  warnings: string[]
  conflicts: string[]
}

interface AgentWorkbenchViewProps {
  draft: WorkbenchDraftView | null
  taxonomy: WorkbenchTaxonomyView | null
  messages: WorkflowMessage[]
  workflowStage: string
  recognitionReady: boolean
  upstreamDirty: boolean
  manualOverrideReason: string
  chatText: string
  displayedImageUrl: string
  displayedImageName: string
  localImageUrl: string
  imageRetryKey: number
  imageError: string
  zoom: number
  rotation: number
  extracting: boolean
  resolving: boolean
  committing: boolean
  sending: boolean
  skipping: boolean
  materials: MaterialItemInfo[]
  materialSummary: MaterialSummary | null
  nextPreview: MaterialPreview | null
  currentMaterialId?: number
  draftExcelRow: Record<string, string> | null
  highlightRow: number | null
  previewRevision: number
  inspectorTab: InspectorTab
  inspectorOpen: boolean
  onInspectorTabChange: (tab: InspectorTab) => void
  onInspectorOpenChange: (open: boolean) => void
  onChooseFile: () => void
  onDropFile: (file: File) => void
  onStartNextMaterial: () => void
  onRecognitionChange: (field: string, value: string) => void
  onResolve: () => void
  onRetryTaxonomy: () => void
  onTaxonomyChange: (field: string, value: string) => void
  onInternalTaxonomyChange: (field: string, value: string) => void
  onManualOverrideReasonChange: (value: string) => void
  onCommit: () => void
  onChatTextChange: (value: string) => void
  onSendMessage: () => void
  onZoomChange: (value: number) => void
  onRotationChange: (value: number) => void
  onImageError: (value: string) => void
  onImageRetry: () => void
  onReExtract: () => void
  onSkip: () => void
  onDiscard: () => void
  onRefreshMaterials: () => void
}

const MATERIAL_LABELS: Record<string, string> = {
  pending: '待处理',
  processing: '处理中',
  completed: '已完成',
  skipped: '已跳过',
  failed: '失败',
}

const MATERIAL_COLORS: Record<string, string> = {
  pending: 'bg-slate-100 text-slate-600',
  processing: 'bg-blue-100 text-blue-700',
  completed: 'bg-emerald-100 text-emerald-700',
  skipped: 'bg-amber-100 text-amber-700',
  failed: 'bg-red-100 text-red-700',
}

function textFromMessage(message: WorkflowMessage) {
  if (typeof message.content === 'string') return message.content
  const value = message.content?.text
  return typeof value === 'string' ? value : ''
}

function verificationPresentation(status: string) {
  if (status === 'verified') {
    return {
      label: '权威来源已核验',
      className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    }
  }
  if (status === 'partially_verified') {
    return {
      label: '部分核验，需人工复核',
      className: 'border-amber-200 bg-amber-50 text-amber-700',
    }
  }
  return {
    label: '未解决，需人工确认',
    className: 'border-red-200 bg-red-50 text-red-700',
  }
}

function TimelineConnector() {
  return <div className="ml-[19px] h-5 w-px bg-slate-200" aria-hidden="true" />
}

function TimelineEvent({
  icon,
  title,
  meta,
  tone = 'slate',
  children,
}: {
  icon: ReactNode
  title: string
  meta?: string
  tone?: 'slate' | 'emerald' | 'blue' | 'amber'
  children: ReactNode
}) {
  const toneClasses = {
    slate: 'border-slate-200 bg-white',
    emerald: 'border-emerald-200 bg-white shadow-[0_10px_30px_rgba(5,150,105,0.06)]',
    blue: 'border-blue-200 bg-white shadow-[0_10px_30px_rgba(37,99,235,0.05)]',
    amber: 'border-amber-200 bg-white',
  }
  const iconClasses = {
    slate: 'bg-slate-100 text-slate-600',
    emerald: 'bg-emerald-600 text-white',
    blue: 'bg-blue-600 text-white',
    amber: 'bg-amber-500 text-white',
  }

  return (
    <article className="relative pl-12">
      <div className={`absolute left-0 top-0 flex h-10 w-10 items-center justify-center rounded-full ring-4 ring-[#f6f8f7] ${iconClasses[tone]}`}>
        {icon}
      </div>
      <div className={`overflow-hidden rounded-2xl border ${toneClasses[tone]}`}>
        <header className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
            {meta ? <p className="mt-0.5 text-xs text-slate-400">{meta}</p> : null}
          </div>
        </header>
        <div className="p-4">{children}</div>
      </div>
    </article>
  )
}

function EmptyConversation({
  extracting,
  pendingCount,
  quotaExhausted,
  onChooseFile,
  onDropFile,
  onStartNextMaterial,
}: {
  extracting: boolean
  pendingCount: number
  quotaExhausted: boolean
  onChooseFile: () => void
  onDropFile: (file: File) => void
  onStartNextMaterial: () => void
}) {
  return (
    <div className="mx-auto flex min-h-full max-w-2xl items-center px-6 py-16">
      <div className="w-full text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-600 text-white shadow-lg shadow-emerald-200">
          <Sparkles className="h-7 w-7" />
        </div>
        <h2 className="mt-5 text-xl font-semibold text-slate-900">开始整理一张昆虫标本</h2>
        <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-slate-500">
          AI 会依次提出标签识别、权威分类和 Excel 写入建议，每一步都由你编辑并明确确认。
        </p>
        <div
          role="button"
          tabIndex={extracting ? -1 : 0}
          aria-disabled={extracting}
          aria-label="上传标本图片"
          onClick={() => {
            if (!extracting) onChooseFile()
          }}
          onKeyDown={(event) => {
            if (!extracting && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault()
              onChooseFile()
            }
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault()
            if (extracting) return
            const file = event.dataTransfer.files[0]
            if (file) onDropFile(file)
          }}
          className="mt-8 flex min-h-44 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-emerald-300 bg-emerald-50/50 px-6 transition hover:border-emerald-500 hover:bg-emerald-50 focus:outline-none focus:ring-2 focus:ring-emerald-500"
        >
          {extracting ? (
            <>
              <Loader2 className="h-8 w-8 animate-spin text-emerald-600" />
              <span className="mt-3 text-sm font-medium text-emerald-700">正在识别图片…</span>
            </>
          ) : (
            <>
              <Upload className="h-8 w-8 text-emerald-600" />
              <span className="mt-3 text-sm font-medium text-slate-700">点击或拖拽上传标本图片</span>
              <span className="mt-1 text-xs text-slate-400">支持 JPG、PNG 和 WebP</span>
            </>
          )}
        </div>
        {pendingCount > 0 ? (
          <button
            type="button"
            onClick={onStartNextMaterial}
            disabled={extracting || quotaExhausted}
            className="mt-4 inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Images className="h-4 w-4" />
            处理下一张素材（{pendingCount}）
          </button>
        ) : null}
      </div>
    </div>
  )
}

function RecognitionCard({
  draft,
  taxonomyReady,
  recognitionReady,
  extracting,
  resolving,
  onChange,
  onResolve,
}: {
  draft: WorkbenchDraftView
  taxonomyReady: boolean
  recognitionReady: boolean
  extracting: boolean
  resolving: boolean
  onChange: (field: string, value: string) => void
  onResolve: () => void
}) {
  return (
    <TimelineEvent
      icon={taxonomyReady ? <Check className="h-5 w-5" /> : <Sparkles className="h-5 w-5" />}
      title="AI 已完成标签识别"
      meta={taxonomyReady ? '你已确认此步骤，可继续复核分类结果' : '请逐项检查，AI 不会自动采用这些字段'}
      tone="emerald"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {RECOGNITION_FIELDS.map((field) => {
          const required = field === '中名' || field === '图像'
          const confidence = draft.confidence[field]
          const evidence = draft.evidence[field]?.trim()
          return (
            <label key={field} className={field === '标签学名' ? 'sm:col-span-2' : ''}>
              <span className="mb-1.5 flex items-center justify-between text-xs font-medium text-slate-600">
                <span>
                  {field}
                  {required ? <span className="text-red-500"> *</span> : null}
                </span>
                {confidence ? (
                  <span className={CONFIDENCE_COLORS[confidence] ?? 'text-slate-400'}>
                    {CONFIDENCE_LABELS[confidence] ?? confidence}
                  </span>
                ) : null}
              </span>
              <input
                aria-label={field}
                type={field === '采集日期' ? 'date' : 'text'}
                value={draft.extracted[field] ?? ''}
                disabled={extracting || resolving}
                onChange={(event) => onChange(field, event.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500"
              />
              {evidence ? (
                <span
                  aria-label={`${field}原文证据`}
                  className="mt-1.5 block rounded-md bg-slate-50 px-2 py-1 text-[11px] leading-4 text-slate-500"
                >
                  标签原文：{evidence}
                </span>
              ) : null}
            </label>
          )
        })}
      </div>
      {draft.warnings.length > 0 ? (
        <div className="mt-3 space-y-1 rounded-xl border border-amber-200 bg-amber-50 p-3">
          {draft.warnings.map((warning) => (
            <p key={warning} className="flex gap-2 text-xs text-amber-800">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              {warning}
            </p>
          ))}
        </div>
      ) : null}
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
        <p className="text-xs text-slate-400">确认后才会查询权威分类，仍不会写入 Excel。</p>
        <button
          type="button"
          onClick={onResolve}
          disabled={!recognitionReady || extracting || resolving}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {resolving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          {taxonomyReady ? '重新确认并解析分类' : '确认标签信息并解析分类'}
        </button>
      </div>
    </TimelineEvent>
  )
}

function TaxonomyCard({
  taxonomy,
  upstreamDirty,
  extracting,
  resolving,
  manualOverrideReason,
  onRetry,
  onFieldChange,
  onInternalChange,
  onManualOverrideReasonChange,
}: {
  taxonomy: WorkbenchTaxonomyView
  upstreamDirty: boolean
  extracting: boolean
  resolving: boolean
  manualOverrideReason: string
  onRetry: () => void
  onFieldChange: (field: string, value: string) => void
  onInternalChange: (field: string, value: string) => void
  onManualOverrideReasonChange: (value: string) => void
}) {
  const verification = verificationPresentation(taxonomy.verification)
  const warnings = [...taxonomy.warnings, ...taxonomy.conflicts]
  return (
    <TimelineEvent
      icon={resolving ? <Loader2 className="h-5 w-5 animate-spin" /> : <BookOpen className="h-5 w-5" />}
      title="AI 已查询权威分类"
      meta="分类字段仍是待确认建议，可直接修改"
      tone={taxonomy.verification === 'unresolved' ? 'amber' : 'blue'}
    >
      <div className={`mb-4 flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium ${verification.className}`}>
        {taxonomy.verification === 'verified'
          ? <CheckCircle2 className="h-4 w-4 shrink-0" />
          : <AlertCircle className="h-4 w-4 shrink-0" />}
        {verification.label}
      </div>
      {upstreamDirty ? (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
          <span>你修改了上游标签，必须重新查询分类后才能提交。</span>
          <button
            type="button"
            onClick={onRetry}
            disabled={extracting || resolving}
            className="shrink-0 rounded-lg bg-amber-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
          >
            重新查询
          </button>
        </div>
      ) : null}
      {taxonomy.verification === 'unresolved' ? (
        <div role="alert" className="mb-4 flex gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          分类尚未解决，请检查冲突、来源和字段，必要时重新运行后再明确确认。
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {TAXONOMY_FIELDS.map((field) => (
          <label key={field}>
            <span className="mb-1.5 block text-xs font-medium text-slate-600">{field}</span>
            <input
              aria-label={field}
              value={taxonomy.fields[field] ?? ''}
              disabled={extracting || resolving}
              onChange={(event) => onFieldChange(field, event.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500"
            />
          </label>
        ))}
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {INTERNAL_TAXONOMY_FIELDS.map((field) => (
          <label key={field}>
            <span className="mb-1.5 block text-xs font-medium text-slate-500">{field}（内部分类）</span>
            <input
              aria-label={field}
              value={taxonomy.internal[field] ?? ''}
              disabled={extracting || resolving}
              onChange={(event) => onInternalChange(field, event.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500"
            />
          </label>
        ))}
      </div>
      {warnings.length > 0 ? (
        <div className="mt-3 space-y-1 rounded-xl border border-amber-200 bg-amber-50 p-3">
          {warnings.map((warning, index) => (
            <p key={`${warning}-${index}`} className="flex gap-2 text-xs text-amber-800">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              {warning}
            </p>
          ))}
        </div>
      ) : null}
      <label className="mt-3 block">
        <span className="mb-1.5 block text-xs font-medium text-slate-600">
          人工覆盖说明
          <span className="ml-1 font-normal text-slate-400">（属种与确认学名不一致时必填）</span>
        </span>
        <input
          aria-label="人工覆盖说明"
          value={manualOverrideReason}
          disabled={extracting || resolving}
          onChange={(event) => onManualOverrideReasonChange(event.target.value)}
          placeholder="例如：已复核标签原图，权威候选匹配错误"
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500"
        />
      </label>
      <div className="mt-4 flex justify-end border-t border-slate-100 pt-4">
        <button
          type="button"
          onClick={onRetry}
          disabled={extracting || resolving}
          className="inline-flex items-center gap-2 rounded-lg border border-blue-200 px-3 py-2 text-xs font-medium text-blue-700 transition hover:bg-blue-50 disabled:opacity-50"
        >
          {resolving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          重新运行分类
        </button>
      </div>
    </TimelineEvent>
  )
}

function ExcelConfirmationCard({
  draft,
  taxonomy,
  committing,
  extracting,
  resolving,
  upstreamDirty,
  onPreview,
  onCommit,
}: {
  draft: WorkbenchDraftView
  taxonomy: WorkbenchTaxonomyView
  committing: boolean
  extracting: boolean
  resolving: boolean
  upstreamDirty: boolean
  onPreview: () => void
  onCommit: () => void
}) {
  const summaryFields = [
    ['图像', draft.extracted['图像']],
    ['中名', draft.extracted['中名']],
    ['最终学名', `${taxonomy.fields['属名'] ?? ''} ${taxonomy.fields['种名'] ?? ''}`.trim()],
    ['科名', taxonomy.fields['科名']],
  ]
  return (
    <TimelineEvent
      icon={<FileSpreadsheet className="h-5 w-5" />}
      title="等待确认写入 Excel"
      meta="这是最后一步，提交后记录和配额将原子完成"
      tone="blue"
    >
      <dl className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
        {summaryFields.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs text-slate-400">{label}</dt>
            <dd className="mt-0.5 truncate text-sm font-medium text-slate-700">{value || '未填写'}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-4">
        <button
          type="button"
          onClick={onPreview}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
        >
          <Maximize2 className="h-4 w-4" />
          查看待写入预览
        </button>
        <button
          type="button"
          onClick={onCommit}
          disabled={committing || extracting || resolving || upstreamDirty}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {committing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          明确确认并写入 Excel
        </button>
      </div>
    </TimelineEvent>
  )
}

function ConversationMessages({ messages }: { messages: WorkflowMessage[] }) {
  const visible = messages.filter((message) => {
    const type = message.kind ?? message.message_type
    return !type || ['question', 'explanation'].includes(type)
  })
  if (visible.length === 0) return null
  return (
    <>
      <TimelineConnector />
      <div className="space-y-3 pl-12">
        {visible.map((message, index) => {
          const isUser = message.role === 'user' || message.actor === 'user'
          return (
            <div
              key={message.id ?? `${message.role ?? message.actor}-${index}`}
              className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
            >
              <div className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-6 ${
                isUser
                  ? 'rounded-br-md bg-slate-900 text-white'
                  : 'rounded-bl-md border border-slate-200 bg-white text-slate-700'
              }`}
              >
                {textFromMessage(message)}
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

function InspectorTabs({
  active,
  onChange,
}: {
  active: InspectorTab
  onChange: (tab: InspectorTab) => void
}) {
  const tabs: Array<{ id: InspectorTab; label: string; icon: ReactNode }> = [
    { id: 'image', label: '图片', icon: <ImageIcon className="h-3.5 w-3.5" /> },
    { id: 'evidence', label: '证据', icon: <BookOpen className="h-3.5 w-3.5" /> },
    { id: 'materials', label: '素材', icon: <Images className="h-3.5 w-3.5" /> },
    { id: 'excel', label: 'Excel', icon: <FileSpreadsheet className="h-3.5 w-3.5" /> },
  ]
  return (
    <div className="grid grid-cols-4 gap-1 rounded-xl bg-slate-100 p-1" role="tablist" aria-label="预览信息">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onChange(tab.id)}
          className={`flex items-center justify-center gap-1 rounded-lg px-2 py-2 text-xs font-medium transition ${
            active === tab.id
              ? 'bg-white text-slate-800 shadow-sm'
              : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
    </div>
  )
}

function ImageInspector({
  draft,
  displayedImageUrl,
  displayedImageName,
  localImageUrl,
  imageRetryKey,
  imageError,
  zoom,
  rotation,
  extracting,
  resolving,
  skipping,
  nextPreview,
  materialSummary,
  onChooseFile,
  onStartNextMaterial,
  onZoomChange,
  onRotationChange,
  onImageError,
  onImageRetry,
  onReExtract,
  onSkip,
  onDiscard,
}: Pick<
  AgentWorkbenchViewProps,
  | 'draft'
  | 'displayedImageUrl'
  | 'displayedImageName'
  | 'localImageUrl'
  | 'imageRetryKey'
  | 'imageError'
  | 'zoom'
  | 'rotation'
  | 'extracting'
  | 'resolving'
  | 'skipping'
  | 'nextPreview'
  | 'materialSummary'
  | 'onChooseFile'
  | 'onStartNextMaterial'
  | 'onZoomChange'
  | 'onRotationChange'
  | 'onImageError'
  | 'onImageRetry'
  | 'onReExtract'
  | 'onSkip'
  | 'onDiscard'
>) {
  return (
    <div className="space-y-3">
      <div className="relative flex min-h-72 items-center justify-center overflow-hidden rounded-2xl bg-slate-950">
        {displayedImageUrl ? (
          <AuthenticatedImage
            key={`${displayedImageUrl}:${imageRetryKey}`}
            src={displayedImageUrl}
            fallbackSrc={draft ? localImageUrl : ''}
            alt={displayedImageName}
            onLoadError={onImageError}
            className="max-h-[460px] max-w-full object-contain transition-transform"
            style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }}
          />
        ) : (
          <button
            type="button"
            onClick={onChooseFile}
            className="flex min-h-72 w-full flex-col items-center justify-center gap-3 text-slate-400 transition hover:bg-slate-900 hover:text-white"
          >
            <Upload className="h-8 w-8" />
            <span className="text-sm">选择标本图片</span>
          </button>
        )}
        {extracting ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-950/75 text-white backdrop-blur-sm">
            <Loader2 className="h-8 w-8 animate-spin text-emerald-400" />
            <span className="text-sm">AI 正在识别图片…</span>
          </div>
        ) : null}
        {!draft && nextPreview && displayedImageUrl ? (
          <button
            type="button"
            onClick={onStartNextMaterial}
            disabled={extracting || materialSummary?.quota_exhausted}
            className="absolute bottom-3 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-lg disabled:opacity-50"
          >
            开始识别这张素材
          </button>
        ) : null}
      </div>
      {imageError ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-center">
          <p className="text-xs text-red-700">图片读取失败：{imageError}</p>
          <button type="button" onClick={onImageRetry} className="mt-1 text-xs font-medium text-red-700 underline">
            重新加载图片
          </button>
        </div>
      ) : null}
      {displayedImageUrl ? (
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <button type="button" aria-label="缩小图片" title="缩小" onClick={() => onZoomChange(Math.max(.25, zoom - .25))} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><ZoomOut className="h-4 w-4" /></button>
            <span className="w-10 text-center text-xs text-slate-400">{Math.round(zoom * 100)}%</span>
            <button type="button" aria-label="放大图片" title="放大" onClick={() => onZoomChange(Math.min(4, zoom + .25))} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><ZoomIn className="h-4 w-4" /></button>
            <button type="button" aria-label="逆时针旋转图片" title="逆时针旋转" disabled={extracting} onClick={() => onRotationChange((rotation + 270) % 360)} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"><RotateCcw className="h-4 w-4" /></button>
            <button type="button" aria-label="顺时针旋转图片" title="顺时针旋转" disabled={extracting} onClick={() => onRotationChange((rotation + 90) % 360)} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"><RotateCw className="h-4 w-4" /></button>
          </div>
        </div>
      ) : null}
      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <p className="text-xs font-medium text-slate-400">当前文件</p>
        <p className="mt-1 break-all text-sm font-medium text-slate-700">{displayedImageName}</p>
        {draft ? (
          <span className={`mt-2 inline-flex rounded-full px-2 py-1 text-xs ${STATUS_COLORS[draft.status] ?? 'bg-slate-100 text-slate-600'}`}>
            {STATUS_LABELS[draft.status] ?? draft.status}
          </span>
        ) : null}
      </div>
      {materialSummary?.quota_exhausted && materialSummary.pending_count > 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800">
          工作流配额已用尽（已计费 {materialSummary.quota_charged}
          {materialSummary.quota_total === null ? '' : ` / ${materialSummary.quota_total}`}）。
          当前素材和图片已保留。
        </div>
      ) : null}
      {draft ? (
        <div className="grid grid-cols-3 gap-2">
          <button type="button" onClick={onReExtract} disabled={extracting || resolving} className="flex items-center justify-center gap-1 rounded-lg border border-slate-200 px-2 py-2 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"><RefreshCw className="h-3.5 w-3.5" />重新识别</button>
          <button type="button" onClick={onSkip} disabled={extracting || resolving || !draft.materialItemId || skipping} className="flex items-center justify-center gap-1 rounded-lg border border-amber-200 px-2 py-2 text-xs text-amber-700 hover:bg-amber-50 disabled:opacity-40">{skipping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SkipForward className="h-3.5 w-3.5" />}跳过</button>
          <button type="button" onClick={onDiscard} disabled={extracting || resolving} className="flex items-center justify-center gap-1 rounded-lg border border-red-200 px-2 py-2 text-xs text-red-600 hover:bg-red-50 disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" />放弃</button>
        </div>
      ) : null}
    </div>
  )
}

function EvidenceInspector({
  draft,
  taxonomy,
}: {
  draft: WorkbenchDraftView | null
  taxonomy: WorkbenchTaxonomyView | null
}) {
  const recognitionEvidence = draft
    ? RECOGNITION_FIELDS
      .map((field) => [field, draft.evidence[field]?.trim()] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
    : []
  if (!draft && !taxonomy) {
    return <p className="py-12 text-center text-sm text-slate-400">识别后显示标签原文与分类来源</p>
  }
  const warnings = taxonomy ? [...taxonomy.warnings, ...taxonomy.conflicts] : []
  return (
    <div className="space-y-4">
      {draft ? (
        <section className="rounded-xl border border-slate-200 bg-white p-3">
          <h4 className="flex items-center gap-2 text-xs font-semibold text-slate-700">
            <ImageIcon className="h-3.5 w-3.5" />
            标签识别原文
          </h4>
          {recognitionEvidence.length > 0 ? (
            <dl className="mt-3 space-y-2">
              {recognitionEvidence.map(([field, value]) => (
                <div key={field} className="rounded-lg bg-slate-50 px-2.5 py-2">
                  <dt className="text-[10px] font-medium text-slate-400">{field}</dt>
                  <dd className="mt-0.5 break-words text-xs text-slate-700">{value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="mt-2 text-xs text-slate-400">本次识别未返回原文证据，请直接复核图片。</p>
          )}
        </section>
      ) : null}
      {taxonomy ? (
        <>
          <div className={`rounded-xl border p-3 text-sm ${verificationPresentation(taxonomy.verification).className}`}>
            {verificationPresentation(taxonomy.verification).label}
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <h4 className="flex items-center gap-2 text-xs font-semibold text-slate-700">
              <BookOpen className="h-3.5 w-3.5" />
              分类来源与推导
            </h4>
            <p className="mt-2 text-xs leading-5 text-slate-600">{taxonomy.provenance || '暂无来源摘要'}</p>
          </div>
        </>
      ) : (
        <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
          确认标签后将在此显示权威分类来源。
        </p>
      )}
      {taxonomy && taxonomy.sources.length > 0 ? (
        <div className="space-y-2">
          {taxonomy.sources.map((source, index) => {
            const label = source.title ?? source.label ?? source.citation ?? `来源 ${index + 1}`
            const url = source.url ?? source.href
            return url ? (
              <a key={`${url}-${index}`} href={url} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-xl border border-blue-200 bg-blue-50/50 p-3 text-xs font-medium text-blue-700 hover:bg-blue-50">
                <span>{label}</span>
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            ) : (
              <div key={`${label}-${index}`} className="rounded-xl border border-slate-200 p-3 text-xs text-slate-600">{label}</div>
            )
          })}
        </div>
      ) : null}
      {taxonomy && warnings.length > 0 ? (
        <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
          {warnings.map((warning, index) => (
            <p key={`${warning}-${index}`} className="flex gap-2 text-xs leading-5 text-amber-800">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {warning}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function MaterialsInspector({
  materials,
  materialSummary,
  currentMaterialId,
  onRefresh,
}: {
  materials: MaterialItemInfo[]
  materialSummary: MaterialSummary | null
  currentMaterialId?: number
  onRefresh: () => void
}) {
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-slate-500">
          {materialSummary?.total_count ?? materials.length} 项 · {materialSummary?.pending_count ?? 0} 待处理
        </p>
        <button type="button" aria-label="刷新素材列表" onClick={onRefresh} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100"><RefreshCw className="h-4 w-4" /></button>
      </div>
      <div className="space-y-2">
        {materials.length === 0 ? (
          <p className="py-12 text-center text-sm text-slate-400">暂无素材</p>
        ) : materials.map((item) => {
          const current = item.id === currentMaterialId
          return (
            <div
              key={item.id}
              aria-current={current ? 'true' : undefined}
              className={`flex items-center gap-3 rounded-xl border p-2.5 transition ${
                current
                  ? 'border-emerald-400 bg-emerald-50 ring-1 ring-emerald-100'
                  : 'border-slate-200 bg-white'
              }`}
            >
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-slate-100">
                <ImageIcon className="h-5 w-5 text-slate-400" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-semibold text-slate-500">#{item.sequence}</span>
                  {current ? <span className="text-[10px] font-medium text-emerald-700">当前</span> : null}
                </div>
                <p className="truncate text-xs text-slate-700" title={item.original_filename}>{item.original_filename}</p>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] ${MATERIAL_COLORS[item.status] ?? 'bg-slate-100'}`}>
                {MATERIAL_LABELS[item.status] ?? item.status}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function WorkbenchInspector(props: AgentWorkbenchViewProps) {
  const content = {
    image: (
      <ImageInspector
        draft={props.draft}
        displayedImageUrl={props.displayedImageUrl}
        displayedImageName={props.displayedImageName}
        localImageUrl={props.localImageUrl}
        imageRetryKey={props.imageRetryKey}
        imageError={props.imageError}
        zoom={props.zoom}
        rotation={props.rotation}
        extracting={props.extracting}
        resolving={props.resolving}
        skipping={props.skipping}
        nextPreview={props.nextPreview}
        materialSummary={props.materialSummary}
        onChooseFile={props.onChooseFile}
        onStartNextMaterial={props.onStartNextMaterial}
        onZoomChange={props.onZoomChange}
        onRotationChange={props.onRotationChange}
        onImageError={props.onImageError}
        onImageRetry={props.onImageRetry}
        onReExtract={props.onReExtract}
        onSkip={props.onSkip}
        onDiscard={props.onDiscard}
      />
    ),
    evidence: <EvidenceInspector draft={props.draft} taxonomy={props.taxonomy} />,
    materials: (
      <MaterialsInspector
        materials={props.materials}
        materialSummary={props.materialSummary}
        currentMaterialId={props.currentMaterialId}
        onRefresh={props.onRefreshMaterials}
      />
    ),
    excel: (
      <div className="h-[calc(100vh-170px)] min-h-[460px] overflow-hidden rounded-xl border border-slate-200 bg-white">
        <ExcelPreview
          draftRow={props.draftExcelRow}
          highlightRow={props.highlightRow}
          refreshRevision={props.previewRevision}
        />
      </div>
    ),
  }
  return (
    <>
      {props.inspectorOpen ? (
        <button
          type="button"
          aria-label="关闭预览信息"
          onClick={() => props.onInspectorOpenChange(false)}
          className="fixed inset-0 z-30 bg-slate-950/35 backdrop-blur-sm xl:hidden"
        />
      ) : null}
      <aside className={`${props.inspectorOpen ? 'flex' : 'hidden'} fixed inset-y-0 right-0 z-40 w-[min(94vw,430px)] flex-col border-l border-slate-200 bg-white shadow-2xl xl:static xl:z-auto xl:flex xl:w-[400px] xl:shrink-0 xl:shadow-none`}>
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">标本预览信息</h2>
            <p className="mt-0.5 max-w-[290px] truncate text-xs text-slate-400">{props.displayedImageName}</p>
          </div>
          <button type="button" aria-label="关闭预览信息" onClick={() => props.onInspectorOpenChange(false)} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 xl:hidden"><X className="h-4 w-4" /></button>
        </header>
        <div className="border-b border-slate-100 p-3">
          <InspectorTabs active={props.inspectorTab} onChange={props.onInspectorTabChange} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div role="tabpanel">
            {content[props.inspectorTab]}
          </div>
        </div>
      </aside>
    </>
  )
}

export default function AgentWorkbenchView(props: AgentWorkbenchViewProps) {
  const hasDraft = Boolean(props.draft)
  return (
    <div className="flex h-screen min-w-0 overflow-hidden bg-[#f6f8f7]">
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[65px] shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white px-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-600 text-white">
                <Sparkles className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <h1 className="truncate text-sm font-semibold text-slate-900">智能体标本工作台</h1>
                <p className="truncate text-xs text-slate-400">
                  {props.draft ? props.draft.imageFilename : 'AI 提议，用户逐步确认'}
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {props.draft ? (
              <span className={`hidden rounded-full px-2.5 py-1 text-xs sm:inline-flex ${STATUS_COLORS[props.draft.status] ?? 'bg-slate-100 text-slate-600'}`}>
                {STATUS_LABELS[props.draft.status] ?? props.workflowStage ?? props.draft.status}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => props.onInspectorOpenChange(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 xl:hidden"
            >
              <PanelRight className="h-4 w-4" />
              预览
            </button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          {!hasDraft ? (
            <EmptyConversation
              extracting={props.extracting}
              pendingCount={props.materialSummary?.pending_count ?? 0}
              quotaExhausted={Boolean(props.materialSummary?.quota_exhausted)}
              onChooseFile={props.onChooseFile}
              onDropFile={props.onDropFile}
              onStartNextMaterial={props.onStartNextMaterial}
            />
          ) : (
            <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
              <div className="mb-5 flex items-center gap-3 pl-12">
                <div className="rounded-2xl rounded-bl-md border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-700">
                  我已读取当前标本图片。请先核对标签识别结果，确认后我再查询权威分类。
                </div>
              </div>
              <RecognitionCard
                draft={props.draft!}
                taxonomyReady={Boolean(props.taxonomy)}
                recognitionReady={props.recognitionReady}
                extracting={props.extracting}
                resolving={props.resolving}
                onChange={props.onRecognitionChange}
                onResolve={props.onResolve}
              />
              {props.taxonomy ? (
                <>
                  <TimelineConnector />
                  <TaxonomyCard
                    taxonomy={props.taxonomy}
                    upstreamDirty={props.upstreamDirty}
                    extracting={props.extracting}
                    resolving={props.resolving}
                    manualOverrideReason={props.manualOverrideReason}
                    onRetry={props.onRetryTaxonomy}
                    onFieldChange={props.onTaxonomyChange}
                    onInternalChange={props.onInternalTaxonomyChange}
                    onManualOverrideReasonChange={props.onManualOverrideReasonChange}
                  />
                  <TimelineConnector />
                  <ExcelConfirmationCard
                    draft={props.draft!}
                    taxonomy={props.taxonomy}
                    committing={props.committing}
                    extracting={props.extracting}
                    resolving={props.resolving}
                    upstreamDirty={props.upstreamDirty}
                    onPreview={() => {
                      props.onInspectorTabChange('excel')
                      props.onInspectorOpenChange(true)
                    }}
                    onCommit={props.onCommit}
                  />
                </>
              ) : null}
              <ConversationMessages messages={props.messages} />
            </div>
          )}
        </main>

        <footer className="shrink-0 border-t border-slate-200 bg-white px-4 py-3 sm:px-6">
          <div className="mx-auto max-w-3xl">
            <div className="flex items-end gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm focus-within:border-violet-300 focus-within:ring-2 focus-within:ring-violet-100">
              <MessageSquare className="mb-2 ml-1 h-4 w-4 shrink-0 text-violet-500" />
              <textarea
                aria-label="解释性消息"
                rows={1}
                value={props.chatText}
                onChange={(event) => props.onChatTextChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    props.onSendMessage()
                  }
                }}
                disabled={!props.draft || props.extracting}
                placeholder={props.draft ? '询问 AI 分类依据、冲突或来源…' : '开始工作流后可以与 AI 沟通'}
                className="max-h-28 min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-sm text-slate-700 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed"
              />
              <button
                type="button"
                aria-label="发送消息"
                onClick={props.onSendMessage}
                disabled={!props.draft || props.extracting || !props.chatText.trim() || props.sending}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-600 text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {props.sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </button>
            </div>
            <p className="mt-1.5 text-center text-[11px] text-slate-400">
              对话只用于解释，修改与写入必须通过上方确认卡完成。
            </p>
          </div>
        </footer>
      </section>

      <WorkbenchInspector {...props} />
    </div>
  )
}
