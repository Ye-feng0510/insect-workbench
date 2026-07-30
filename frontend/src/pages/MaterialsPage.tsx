import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Archive,
  ArrowRight,
  CheckCircle2,
  Clock3,
  Download,
  Images,
  Loader2,
  PackageOpen,
  SkipForward,
  Upload,
} from 'lucide-react'
import EmptyState from '@/components/EmptyState'
import Loading from '@/components/Loading'
import { useToast } from '@/components/Toast'
import {
  getMaterialSummary,
  listMaterialItems,
  skippedMaterialsExportUrl,
  uploadMaterialZip,
} from '@/services/materials'
import { extractErrorMessage } from '@/types'
import type { MaterialItemInfo, MaterialSummary } from '@/types'

export default function MaterialsPage() {
  const navigate = useNavigate()
  const { show } = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const uploadingRef = useRef(false)
  const [summary, setSummary] = useState<MaterialSummary | null>(null)
  const [skippedItems, setSkippedItems] = useState<MaterialItemInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    loadData()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const loadData = async () => {
    setLoading(true)
    try {
      const summaryData = await getMaterialSummary()
      setSummary(summaryData)
      if (summaryData.skipped_count > 0) {
        setSkippedItems(
          await listMaterialItems('skipped', summaryData.skipped_count),
        )
      } else {
        setSkippedItems([])
      }
    } catch (e) {
      show(extractErrorMessage(e, '加载数据素材失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  const handleUpload = async (file: File) => {
    if (uploadingRef.current) return
    uploadingRef.current = true
    if (!file.name.toLowerCase().endsWith('.zip')) {
      show('请上传 ZIP 格式的素材压缩包', 'error')
      uploadingRef.current = false
      return
    }
    if (
      summary?.batch
      && !confirm('上传新的素材包后,它将成为当前处理批次。确定继续吗?')
    ) {
      uploadingRef.current = false
      return
    }
    setUploading(true)
    try {
      const data = await uploadMaterialZip(file)
      setSummary(data)
      setSkippedItems([])
      show(`素材包上传成功,共发现 ${data.total_count} 张有效图片`, 'success')
    } catch (e) {
      show(extractErrorMessage(e, '上传素材包失败'), 'error')
    } finally {
      uploadingRef.current = false
      setUploading(false)
    }
  }

  const handledCount = (summary?.completed_count ?? 0) + (summary?.skipped_count ?? 0)
  const progress = summary?.total_count
    ? Math.round((handledCount / summary.total_count) * 100)
    : 0

  if (loading) {
    return <Loading label="正在加载数据素材..." />
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">数据素材图片</h1>
          <p className="mt-1 text-sm text-gray-500">
            上传图片素材压缩包,并跟踪识别录入进度
          </p>
        </div>
        {summary?.batch && summary.pending_count + summary.processing_count > 0 ? (
          <button
            onClick={() => navigate('/workbench')}
            className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
          >
            前往识别工作台
            <ArrowRight className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      <div className="grid grid-cols-4 gap-4">
        <StatCard
          label="素材总数"
          value={summary?.total_count ?? 0}
          icon={<Images className="h-5 w-5" />}
          color="blue"
        />
        <StatCard
          label="已完成录入"
          value={summary?.completed_count ?? 0}
          icon={<CheckCircle2 className="h-5 w-5" />}
          color="emerald"
        />
        <StatCard
          label="已跳过"
          value={summary?.skipped_count ?? 0}
          icon={<SkipForward className="h-5 w-5" />}
          color="amber"
        />
        <StatCard
          label="待处理"
          value={(summary?.pending_count ?? 0) + (summary?.processing_count ?? 0)}
          icon={<Clock3 className="h-5 w-5" />}
          color="gray"
        />
      </div>

      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(320px,0.6fr)] gap-5">
        <div className="space-y-5">
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <div className="mb-4 flex items-center gap-2">
              <Archive className="h-5 w-5 text-emerald-600" />
              <h2 className="font-semibold text-gray-700">上传素材压缩包</h2>
            </div>
            <div
              onClick={() => !uploading && fileRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault()
                setDragging(false)
                const file = event.dataTransfer.files[0]
                if (file && !uploading) handleUpload(file)
              }}
              className={`flex min-h-52 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 text-center transition-colors ${
                dragging
                  ? 'border-emerald-500 bg-emerald-50'
                  : 'border-gray-300 bg-gray-50 hover:border-emerald-400 hover:bg-emerald-50/40'
              }`}
            >
              {uploading ? (
                <>
                  <Loader2 className="mb-3 h-10 w-10 animate-spin text-emerald-600" />
                  <p className="text-sm font-medium text-emerald-700">
                    正在上传、检查并解压素材...
                  </p>
                  <p className="mt-1 text-xs text-gray-400">图片较多时请耐心等待</p>
                </>
              ) : (
                <>
                  <Upload className="mb-3 h-10 w-10 text-emerald-500" />
                  <p className="text-sm font-medium text-gray-700">点击或拖拽上传 ZIP 文件</p>
                  <p className="mt-1 text-xs text-gray-400">
                    自动读取 JPG、JPEG、PNG、WebP,支持中文文件名和多层文件夹
                  </p>
                </>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) handleUpload(file)
                event.target.value = ''
              }}
            />
          </div>

          {summary?.batch ? (
            <div className="rounded-xl border border-gray-200 bg-white p-5">
              <div className="mb-4 flex items-start justify-between">
                <div className="min-w-0">
                  <p className="text-xs text-gray-400">当前素材包</p>
                  <p className="mt-1 truncate font-medium text-gray-700">
                    {summary.batch.original_filename}
                  </p>
                  <p className="mt-1 text-xs text-gray-400">
                    上传于 {new Date(summary.batch.created_at).toLocaleString('zh-CN', { hour12: false })}
                  </p>
                </div>
                <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs text-emerald-700">
                  当前批次
                </span>
              </div>
              <div className="mb-2 flex justify-between text-xs text-gray-500">
                <span>整体进度</span>
                <span>{handledCount} / {summary.total_count} ({progress}%)</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-gray-100">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
              {summary.failed_count > 0 ? (
                <p className="mt-3 text-xs text-red-500">
                  另有 {summary.failed_count} 张素材处理异常
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <SkipForward className="h-5 w-5 text-amber-500" />
              <h2 className="font-semibold text-gray-700">跳过的数据素材</h2>
            </div>
            <span className="text-sm font-bold text-amber-600">
              {summary?.skipped_count ?? 0}
            </span>
          </div>

          {skippedItems.length === 0 ? (
            <EmptyState
              icon={<PackageOpen className="h-10 w-10" />}
              title="暂无跳过的素材"
              description="在识别工作台跳过图片后,文件将记录在这里"
            />
          ) : (
            <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
              {skippedItems.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs"
                >
                  <span className="w-8 shrink-0 text-amber-500">#{item.sequence}</span>
                  <span className="min-w-0 flex-1 truncate text-gray-600" title={item.archive_path}>
                    {item.archive_path}
                  </span>
                </div>
              ))}
            </div>
          )}

          <a
            href={summary?.skipped_count ? skippedMaterialsExportUrl : undefined}
            onClick={(event) => {
              if (!summary?.skipped_count) event.preventDefault()
            }}
            className={`mt-4 flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium ${
              summary?.skipped_count
                ? 'bg-amber-500 text-white hover:bg-amber-600'
                : 'cursor-not-allowed bg-gray-100 text-gray-400'
            }`}
          >
            <Download className="h-4 w-4" />
            导出所有跳过素材 ZIP
          </a>
        </div>
      </div>
    </div>
  )
}

interface StatCardProps {
  label: string
  value: number
  icon: ReactNode
  color: 'blue' | 'emerald' | 'amber' | 'gray'
}

const statColors = {
  blue: 'bg-blue-50 text-blue-600',
  emerald: 'bg-emerald-50 text-emerald-600',
  amber: 'bg-amber-50 text-amber-600',
  gray: 'bg-gray-100 text-gray-600',
}

function StatCard({ label, value, icon, color }: StatCardProps) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-4">
      <div className={`rounded-lg p-2.5 ${statColors[color]}`}>{icon}</div>
      <div>
        <p className="text-xs text-gray-500">{label}</p>
        <p className="mt-0.5 text-2xl font-bold text-gray-800">{value}</p>
      </div>
    </div>
  )
}
