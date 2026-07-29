import { useState, useEffect } from 'react'
import { Download, FileSpreadsheet, Loader2, CheckCircle, AlertCircle } from 'lucide-react'
import { useToast } from '@/components/Toast'
import Loading from '@/components/Loading'
import { getExportSummary, exportExcel } from '@/services/export'
import { extractErrorMessage, type ExportSummary } from '@/types'

export default function ExportPage() {
  const { show } = useToast()
  const [summary, setSummary] = useState<ExportSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [lastExport, setLastExport] = useState<{ url: string; count: number } | null>(null)

  useEffect(() => {
    loadSummary()
  }, [])

  const loadSummary = async () => {
    setLoading(true)
    try {
      const data = await getExportSummary()
      setSummary(data)
    } catch (e) {
      show(extractErrorMessage(e, '加载汇总失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const result = await exportExcel()
      setLastExport({ url: result.download_url, count: result.record_count })
      show(`已导出 ${result.record_count} 条记录`, 'success')
    } catch (e) {
      show(extractErrorMessage(e, '导出失败'), 'error')
    } finally {
      setExporting(false)
    }
  }

  if (loading) {
    return <Loading />
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold text-gray-800">Excel 导出</h1>

      {/* 汇总信息 */}
      {summary && (
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-gray-700">导出汇总</h2>
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-lg bg-emerald-50 p-4">
              <p className="text-sm text-gray-500">已完成记录</p>
              <p className="mt-1 text-2xl font-bold text-emerald-600">{summary.completed_count}</p>
            </div>
            <div className="rounded-lg bg-yellow-50 p-4">
              <p className="text-sm text-gray-500">待确认记录</p>
              <p className="mt-1 text-2xl font-bold text-yellow-600">{summary.awaiting_confirmation_count}</p>
            </div>
          </div>

          <div className="mt-4 space-y-2 border-t border-gray-100 pt-4 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">模板名称</span>
              <span className="font-medium text-gray-700">{summary.template_name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">目标工作表</span>
              <span className="font-medium text-gray-700">{summary.target_sheet}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">开始写入行</span>
              <span className="font-medium text-gray-700">第 {summary.start_write_row} 行</span>
            </div>
          </div>
        </div>
      )}

      {/* 导出说明 */}
      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-start gap-2">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-blue-500" />
          <div className="text-sm text-gray-500">
            <p className="mb-1 font-medium text-gray-600">导出说明</p>
            <ul className="list-inside list-disc space-y-1">
              <li>只导出已完成的记录(待确认的草稿不导出)</li>
              <li>按记录 ID 升序写入,行号 = 开始写入行 + 序号</li>
              <li>只修改 13 个目标字段,保留模板原有数据和其他列</li>
              <li>采集日期写为 Excel 日期格式 (yyyy-mm-dd)</li>
              <li>图像编号以文本格式写入,避免被自动转换</li>
              <li>原始模板不会被覆盖</li>
            </ul>
          </div>
        </div>

        <button
          onClick={handleExport}
          disabled={exporting || !summary || summary.completed_count === 0}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {exporting ? (
            <><Loader2 className="h-5 w-5 animate-spin" /> 正在生成 Excel...</>
          ) : (
            <><Download className="h-5 w-5" /> 导出 Excel ({summary?.completed_count ?? 0} 条)</>
          )}
        </button>

        {!summary || summary.completed_count === 0 ? (
          <p className="mt-2 text-center text-xs text-gray-400">
            没有已完成的记录,请先在识别工作台完成图片识别
          </p>
        ) : null}
      </div>

      {/* 导出结果 */}
      {lastExport && (
        <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <CheckCircle className="h-6 w-6 shrink-0 text-emerald-600" />
          <div className="flex-1">
            <p className="text-sm font-medium text-emerald-800">
              导出成功 ({lastExport.count} 条记录)
            </p>
            <a
              href={lastExport.url}
              className="mt-1 flex items-center gap-1 text-xs text-emerald-600 hover:underline"
            >
              <FileSpreadsheet className="h-3 w-3" />
              点击下载文件
            </a>
          </div>
        </div>
      )}
    </div>
  )
}
