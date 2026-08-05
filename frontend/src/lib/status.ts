/** 识别工作台状态机常量(与后端 models.py 一致)。 */
export const STATUS = {
  UPLOADED: 'uploaded',
  EXTRACTING: 'extracting',
  AWAITING_CONFIRMATION: 'awaiting_confirmation',
  AWAITING_TAXONOMY_CONFIRMATION: 'awaiting_taxonomy_confirmation',
  CLASSIFYING: 'classifying',
  COMPLETED: 'completed',
  EXTRACTION_FAILED: 'extraction_failed',
  CLASSIFICATION_FAILED: 'classification_failed',
  DISCARDED: 'discarded',
} as const

export type RecordStatus = (typeof STATUS)[keyof typeof STATUS]

/** 活跃草稿状态集合(前端恢复用)。 */
export const ACTIVE_DRAFT_STATUSES: RecordStatus[] = [
  STATUS.UPLOADED,
  STATUS.EXTRACTING,
  STATUS.AWAITING_CONFIRMATION,
  STATUS.AWAITING_TAXONOMY_CONFIRMATION,
  STATUS.CLASSIFYING,
  STATUS.EXTRACTION_FAILED,
  STATUS.CLASSIFICATION_FAILED,
]

/** 状态中文标签。 */
export const STATUS_LABELS: Record<string, string> = {
  uploaded: '已上传',
  extracting: '正在提取图片信息',
  awaiting_confirmation: '等待确认图片信息',
  awaiting_taxonomy_confirmation: '等待确认分类信息',
  classifying: '正在整理分类信息',
  completed: '已完成并填表',
  extraction_failed: '图片识别失败',
  classification_failed: '分类失败',
  discarded: '已废弃',
}

/** 状态颜色(badge 变体)。 */
export const STATUS_COLORS: Record<string, string> = {
  uploaded: 'bg-gray-100 text-gray-600',
  extracting: 'bg-blue-100 text-blue-700',
  awaiting_confirmation: 'bg-yellow-100 text-yellow-700',
  awaiting_taxonomy_confirmation: 'bg-blue-100 text-blue-700',
  classifying: 'bg-purple-100 text-purple-700',
  completed: 'bg-emerald-100 text-emerald-700',
  extraction_failed: 'bg-red-100 text-red-700',
  classification_failed: 'bg-red-100 text-red-700',
  discarded: 'bg-gray-100 text-gray-400',
}

/** 置信度中文标签。 */
export const CONFIDENCE_LABELS: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
}

/** 置信度颜色。 */
export const CONFIDENCE_COLORS: Record<string, string> = {
  high: 'text-emerald-600',
  medium: 'text-amber-500',
  low: 'text-red-500',
}

/** 5 个图片提取字段。 */
export const IMAGE_FIELDS = ['中名', '产地3', '图像', '采集人', '采集日期'] as const

/** 用户手工录入的可选字段。 */
export const MANUAL_OPTIONAL_FIELDS = ['鉴定人'] as const

/** 8 个分类补全字段。 */
export const TAXONOMY_FIELDS = [
  'Phylum', '纲', 'Class', 'Order', '中文科名', '科名', '属名', '种名',
] as const
