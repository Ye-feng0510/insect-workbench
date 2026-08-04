import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import {
  DataGrid,
  type Column,
  type DataGridHandle,
  type RenderEditCellProps,
} from 'react-data-grid'
import { Loader2, Columns3, List, RefreshCw, TableProperties } from 'lucide-react'
import { useToast } from '@/components/Toast'
import EmptyState from '@/components/EmptyState'
import { getPreview } from '@/services/preview'
import { updateRecord } from '@/services/records'
import { getCurrentTemplate } from '@/services/templates'
import { extractErrorMessage } from '@/types'
import type { PreviewResponse } from '@/types'
import { TARGET_FIELDS } from '@/lib/excelColumns'

const EDITABLE_FIELDS = new Set([
  '中名', 'Phylum', '纲', 'Class', 'Order', '中文科名', '科名',
  '属名', '种名', '产地3', '图像', '采集人', '采集日期', '鉴定人',
])

function TextEditor({
  row,
  column,
  onRowChange,
  inputType = 'text',
}: RenderEditCellProps<Row> & { inputType?: 'text' | 'date' }) {
  return (
    <input
      autoFocus
      type={inputType}
      value={String(row[column.key] ?? '')}
      onChange={(event) => onRowChange({ ...row, [column.key]: event.target.value })}
      className="h-full w-full border-2 border-blue-500 bg-white px-1 text-xs outline-none"
    />
  )
}

interface ExcelPreviewProps {
  /** 外部传入的临时行数据(待确认草稿)。 */
  draftRow?: Record<string, string> | null
  /** 最近完成的 Excel 行号(用于绿色高亮)。 */
  highlightRow?: number | null
  /** 高亮后是否自动滚动。 */
  autoScroll?: boolean
  /** 强制刷新令牌,用于同一 Excel 行被覆盖时重新加载。 */
  refreshRevision?: number
}

export default function ExcelPreview({
  draftRow,
  highlightRow,
  autoScroll = true,
  refreshRevision = 0,
}: ExcelPreviewProps) {
  const { show } = useToast()
  const [data, setData] = useState<PreviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<'target' | 'all'>('target')
  const [zoom, setZoom] = useState(100)
  const [savingCells, setSavingCells] = useState<Set<string>>(new Set())
  const gridRef = useRef<DataGridHandle>(null)

  const loadPreview = useCallback(async () => {
    setLoading(true)
    try {
      const template = await getCurrentTemplate()
      if (!template?.target_sheet) {
        setData(null)
        return
      }
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

  // 完成或覆盖记录后重新加载。refreshRevision 可处理行号没有变化的覆盖。
  useEffect(() => {
    if (highlightRow) {
      loadPreview()
    }
  }, [highlightRow, refreshRevision]) // eslint-disable-line react-hooks/exhaustive-deps

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
      key: col.letter,
      name: col.field,
      width: 120,
      editable: (row) => (
        row.__status__ === 'completed'
        && row.__record_id__ !== null
        && EDITABLE_FIELDS.has(col.field)
        && !savingCells.has(`${row.__record_id__}:${col.field}`)
      ),
      renderEditCell: (props) => (
        <TextEditor
          {...props}
          inputType={col.field === '采集日期' ? 'date' : 'text'}
        />
      ),
      renderHeaderCell: () => (
        <div className="flex flex-col">
          <span className="text-xs font-bold text-gray-500">{col.letter}</span>
          <span className="text-xs text-gray-700">{col.field}</span>
        </div>
      ),
      renderCell: ({ row }) => {
        const val = row[col.letter] ?? ''
        const display = val === '' ? '' : String(val)
        const saving = row.__record_id__ !== null
          && savingCells.has(`${row.__record_id__}:${col.field}`)
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
        return (
          <span
            className={`flex items-center gap-1 px-1 text-xs ${
              row.__status__ === 'completed' && EDITABLE_FIELDS.has(col.field)
                ? 'cursor-text text-gray-700 hover:bg-blue-50'
                : 'text-gray-700'
            }`}
            title={row.__status__ === 'completed' && EDITABLE_FIELDS.has(col.field) ? '双击编辑' : undefined}
          >
            {display}
            {saving && <Loader2 className="ml-auto h-3 w-3 animate-spin text-blue-500" />}
          </span>
        )
      },
    }))

    return [rowNumCol, ...dataCols]
  }, [data, savingCells])

  // 构建行数据
  const rows: Row[] = useMemo(() => {
    if (!data) return []
    const result: Row[] = []

    // 模板行 + 已完成记录行
    for (const r of data.rows) {
      const row: Row = {
        __excel_row__: r.excel_row,
        __record_id__: r.record_id,
        __status__: r.status,
        __highlight__: highlightRow === r.excel_row,
        __is_next__: r.excel_row === data.next_write_row,
      }
      for (const col of data.columns) {
        row[col.letter] = r.values[col.field] ?? ''
      }
      result.push(row)
    }

    // 临时草稿行(在 next_write_row 位置)
    if (draftRow && Object.keys(draftRow).length > 0) {
      const draftRowData: Row = {
        __excel_row__: data.next_write_row,
        __record_id__: null,
        __status__: 'draft',
        __highlight__: false,
        __is_next__: false,
      }
      // 填入草稿字段值
      if (data.columns) {
        for (const col of data.columns) {
          draftRowData[col.letter] = draftRow[col.field] ?? ''
        }
      }
      result.push(draftRowData)
    }

    return result
  }, [data, draftRow, highlightRow])

  const handleRowsChange = useCallback((
    nextRows: Row[],
    change: { indexes: number[]; column: { key: string } },
  ) => {
    const rowIndex = change.indexes[0]
    const previousRow = rows[rowIndex]
    const nextRow = nextRows[rowIndex]
    const column = data?.columns.find((item) => item.letter === change.column.key)
    if (
      !data
      || !previousRow
      || !nextRow
      || !column
      || !EDITABLE_FIELDS.has(column.field)
      || previousRow.__status__ !== 'completed'
      || previousRow.__record_id__ === null
    ) {
      return
    }

    const previousValue = String(previousRow[column.letter] ?? '')
    const nextValue = String(nextRow[column.letter] ?? '')
    if (previousValue === nextValue) return

    const recordId = previousRow.__record_id__
    const cellKey = `${recordId}:${column.field}`
    setData((current) => current ? {
      ...current,
      rows: current.rows.map((row) => (
        row.record_id === recordId
          ? { ...row, values: { ...row.values, [column.field]: nextValue } }
          : row
      )),
    } : current)
    setSavingCells((current) => new Set(current).add(cellKey))

    void updateRecord(recordId, { [column.field]: nextValue })
      .then((updated) => {
        const savedValue = updated.fields[column.field] ?? ''
        setData((current) => current ? {
          ...current,
          rows: current.rows.map((row) => (
            row.record_id === recordId
              ? { ...row, values: { ...row.values, [column.field]: savedValue } }
              : row
          )),
          last_updated: new Date().toISOString(),
        } : current)
        show(`已更新第 ${previousRow.__excel_row__} 行的“${column.field}”`, 'success')
      })
      .catch((error) => {
        setData((current) => current ? {
          ...current,
          rows: current.rows.map((row) => (
            row.record_id === recordId
              ? { ...row, values: { ...row.values, [column.field]: previousValue } }
              : row
          )),
        } : current)
        show(extractErrorMessage(error, '保存单元格失败'), 'error')
      })
      .finally(() => {
        setSavingCells((current) => {
          const next = new Set(current)
          next.delete(cellKey)
          return next
        })
      })
  }, [data, rows, show])

  // 使用网格公开 API 定位虚拟化列表中的绝对行。
  useEffect(() => {
    if (autoScroll && highlightRow && rows.length > 0) {
      const idx = rows.findIndex((r) => r.__excel_row__ === highlightRow)
      if (idx >= 0 && gridRef.current) {
        gridRef.current.scrollToCell({ rowIdx: idx })
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
          description="请先在“模板与导出”页面上传模板并完成字段映射"
        />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col rounded-xl border border-gray-200 bg-white">
      {/* 工具栏 */}
      <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-gray-700">Excel 实时预览与编辑</span>
          <span className="text-xs text-gray-400">{data.sheet_name}</span>
          <span className="text-xs text-blue-500">双击已完成记录可编辑</span>
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
              {TARGET_FIELDS.length}字段
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
      <div className="flex-1 overflow-hidden" style={{ fontSize: `${zoom / 100 * 0.875}rem` }}>
        <DataGrid
          ref={gridRef}
          columns={columns}
          rows={rows}
          onRowsChange={handleRowsChange}
          rowHeight={32}
          headerRowHeight={44}
          className="rdg-light"
          style={{ height: '100%' }}
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

interface Row extends Record<string, string | number | boolean | null | undefined> {
  __excel_row__: number
  __record_id__: number | null
  __status__: string
  __highlight__: boolean
  __is_next__: boolean
}
