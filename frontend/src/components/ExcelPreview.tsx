import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { DataGrid, type Column } from 'react-data-grid'
import { Loader2, Columns3, List, RefreshCw, TableProperties } from 'lucide-react'
import { useToast } from '@/components/Toast'
import EmptyState from '@/components/EmptyState'
import { getPreview } from '@/services/preview'
import { extractErrorMessage } from '@/types'
import type { PreviewResponse } from '@/types'

interface ExcelPreviewProps {
  /** 外部传入的临时行数据(待确认草稿)。 */
  draftRow?: Record<string, string> | null
  /** 最近完成的 Excel 行号(用于绿色高亮)。 */
  highlightRow?: number | null
  /** 高亮后是否自动滚动。 */
  autoScroll?: boolean
}

export default function ExcelPreview({ draftRow, highlightRow, autoScroll = true }: ExcelPreviewProps) {
  const { show } = useToast()
  const [data, setData] = useState<PreviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<'target' | 'all'>('target')
  const [zoom, setZoom] = useState(100)
  const gridRef = useRef<HTMLDivElement>(null)

  const loadPreview = useCallback(async () => {
    setLoading(true)
    try {
      const result = await getPreview(mode)
      setData(result)
    } catch (e) {
      if (!data) {
        // 首次加载失败才提示(避免模板未配置时反复弹toast)
        show(extractErrorMessage(e, '加载预览失败'), 'error')
      }
    } finally {
      setLoading(false)
    }
  }, [mode]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadPreview()
  }, [loadPreview])

  // 当 highlightRow 变化时重新加载并滚动
  useEffect(() => {
    if (highlightRow) {
      loadPreview()
    }
  }, [highlightRow]) // eslint-disable-line react-hooks/exhaustive-deps

  // 构建行号列 + 数据列
  const columns: Column<Row>[] = useMemo(() => {
    if (!data) return []

    // 行号列(冻结)
    const rowNumCol: Column<Row> = {
      key: '__row_num__',
      name: '',
      width: 60,
      frozen: true,
      resizable: false,
      renderHeaderCell: () => <span className="text-xs text-gray-400">#</span>,
      renderCell: ({ row }) => (
        <span className={`text-xs ${row.__highlight__ ? 'font-bold text-emerald-600' : 'text-gray-400'}`}>
          {row.__excel_row__}
        </span>
      ),
    }

    // 数据列
    const dataCols: Column<Row>[] = data.columns.map((col) => ({
      key: col.field,
      name: col.field,
      width: 120,
      renderHeaderCell: () => (
        <div className="flex flex-col">
          <span className="text-xs font-bold text-gray-500">{col.letter}</span>
          <span className="text-xs text-gray-700">{col.field}</span>
        </div>
      ),
      renderCell: ({ row }) => {
        const val = row[col.field] ?? ''
        const display = val === '' ? '' : String(val)
        // 临时行黄色
        if (row.__status__ === 'draft') {
          return <span className="bg-yellow-50 px-1 text-xs text-gray-700">{display}</span>
        }
        // 完成高亮行绿色
        if (row.__highlight__) {
          return <span className="bg-emerald-50 px-1 text-xs font-medium text-emerald-800">{display}</span>
        }
        // 下一条写入行蓝色边框
        if (row.__is_next__) {
          return <span className="border border-blue-300 px-1 text-xs text-gray-500">{display}</span>
        }
        return <span className="px-1 text-xs text-gray-700">{display}</span>
      },
    }))

    return [rowNumCol, ...dataCols]
  }, [data])

  // 构建行数据
  const rows: Row[] = useMemo(() => {
    if (!data) return []
    const result: Row[] = []

    // 模板行 + 已完成记录行
    for (const r of data.rows) {
      const row: Row = {
        __excel_row__: r.excel_row,
        __status__: r.status,
        __highlight__: highlightRow === r.excel_row,
        __is_next__: r.excel_row === data.next_write_row,
        ...r.values,
      }
      result.push(row)
    }

    // 临时草稿行(在 next_write_row 位置)
    if (draftRow && Object.keys(draftRow).length > 0) {
      const draftRowData: Row = {
        __excel_row__: data.next_write_row,
        __status__: 'draft',
        __highlight__: false,
        __is_next__: false,
      }
      // 填入草稿字段值
      if (data.columns) {
        for (const col of data.columns) {
          draftRowData[col.field] = draftRow[col.field] ?? ''
        }
      }
      result.push(draftRowData)
    }

    return result
  }, [data, draftRow, highlightRow])

  // 自动滚动到高亮行
  useEffect(() => {
    if (autoScroll && highlightRow && rows.length > 0) {
      const idx = rows.findIndex((r) => r.__excel_row__ === highlightRow)
      if (idx >= 0 && gridRef.current) {
        // react-data-grid 没有直接 scrollToRow API, 用 DOM 滚动
        setTimeout(() => {
          const grid = gridRef.current?.querySelector('.rdg')
          if (grid) {
            const rowEl = grid.querySelectorAll('[role="row"]')[idx + 1] // +1 跳过表头
            rowEl?.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }
        }, 100)
      }
    }
  }, [highlightRow, rows, autoScroll])

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-emerald-600" />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white">
        <EmptyState
          icon={<TableProperties className="h-10 w-10" />}
          title="尚未配置 Excel 模板"
          description="请先在设置页面上传模板并配置字段映射"
        />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col rounded-xl border border-gray-200 bg-white">
      {/* 工具栏 */}
      <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-gray-700">Excel 实时预览</span>
          <span className="text-xs text-gray-400">{data.sheet_name}</span>
        </div>
        <div className="flex items-center gap-2">
          {/* 模式切换 */}
          <div className="flex rounded-md border border-gray-200">
            <button
              onClick={() => setMode('target')}
              className={`flex items-center gap-1 rounded-l-md px-2 py-1 text-xs ${
                mode === 'target' ? 'bg-emerald-50 text-emerald-700' : 'text-gray-500 hover:bg-gray-50'
              }`}
            >
              <List className="h-3 w-3" />
              13字段
            </button>
            <button
              onClick={() => setMode('all')}
              className={`flex items-center gap-1 rounded-r-md border-l border-gray-200 px-2 py-1 text-xs ${
                mode === 'all' ? 'bg-emerald-50 text-emerald-700' : 'text-gray-500 hover:bg-gray-50'
              }`}
            >
              <Columns3 className="h-3 w-3" />
              全部列
            </button>
          </div>
          {/* 缩放 */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setZoom((z) => Math.max(50, z - 25))}
              className="rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-100"
            >
              -
            </button>
            <span className="w-10 text-center text-xs text-gray-500">{zoom}%</span>
            <button
              onClick={() => setZoom((z) => Math.min(150, z + 25))}
              className="rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-100"
            >
              +
            </button>
          </div>
          {/* 刷新 */}
          <button
            onClick={loadPreview}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            title="刷新预览"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 数据网格 */}
      <div ref={gridRef} className="flex-1 overflow-hidden" style={{ fontSize: `${zoom / 100 * 0.875}rem` }}>
        <DataGrid
          columns={columns}
          rows={rows}
          rowHeight={32}
          headerRowHeight={44}
          className="rdg-light"
          style={{ height: '100%' }}
          onCellClick={() => {}} // 只读
        />
      </div>

      {/* 状态栏 */}
      <div className="flex items-center gap-4 border-t border-gray-200 px-3 py-1.5 text-xs text-gray-400">
        <span>工作表: {data.sheet_name}</span>
        <span>已完成: <strong className="text-emerald-600">{data.completed_count}</strong></span>
        <span>预览行数: {data.rows.length}{draftRow ? ' +1' : ''}</span>
        {data.latest_write_row && <span>最新写入: {data.latest_write_row}</span>}
        <span className="text-blue-500">下一条: {data.next_write_row}</span>
        <span className="ml-auto">更新: {new Date(data.last_updated).toLocaleTimeString()}</span>
      </div>
    </div>
  )
}

interface Row extends Record<string, string | number | boolean | undefined> {
  __excel_row__: number
  __status__: string
  __highlight__: boolean
  __is_next__: boolean
}
