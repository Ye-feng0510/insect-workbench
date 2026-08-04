import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/Toast'
import { getPreview } from '@/services/preview'
import { updateRecord } from '@/services/records'
import { getCurrentTemplate } from '@/services/templates'
import ExcelPreview from './ExcelPreview'

interface MockRow extends Record<string, string | number | boolean | null> {
  __record_id__: number | null
}

interface MockColumn {
  key: string
  name: string
  editable?: boolean | ((row: MockRow) => boolean)
}

const scrollToCell = vi.hoisted(() => vi.fn())

vi.mock('react-data-grid', async () => {
  const React = await import('react')
  return {
    DataGrid: React.forwardRef(({
    columns,
    rows,
    onRowsChange,
  }: {
    columns: MockColumn[]
    rows: MockRow[]
    onRowsChange?: (
      rows: MockRow[],
      change: { indexes: number[]; column: MockColumn },
    ) => void
  }, ref: React.ForwardedRef<{ scrollToCell: typeof scrollToCell }>) => {
    React.useImperativeHandle(ref, () => ({ scrollToCell }))
    return (
      <div>
      {rows.flatMap((row, rowIndex) => columns.map((column) => {
        const editable = typeof column.editable === 'function'
          ? column.editable(row)
          : Boolean(column.editable)
        if (!editable) {
          return (
            <span key={`${rowIndex}-${column.key}`}>
              {String(row[column.key] ?? '')}
            </span>
          )
        }
        return (
          <button
            key={`${rowIndex}-${column.key}`}
            aria-label={`edit-${row.__record_id__}-${column.key}`}
            onDoubleClick={() => {
              const nextRows = rows.map((item, index) => (
                index === rowIndex ? { ...item, [column.key]: '深圳湾' } : item
              ))
              onRowsChange?.(nextRows, { indexes: [rowIndex], column })
            }}
          >
            {String(row[column.key] ?? '')}
          </button>
        )
      }))}
      </div>
    )
  }),
  }
})

vi.mock('@/services/preview', () => ({
  getPreview: vi.fn(),
}))

vi.mock('@/services/records', () => ({
  updateRecord: vi.fn(),
}))

vi.mock('@/services/templates', () => ({
  getCurrentTemplate: vi.fn(),
}))

const preview = {
  sheet_name: '标本表',
  mode: 'target',
  header_row: 1,
  base_write_row: 3,
  columns: [
    { letter: 'X', field: '产地3' },
    { letter: 'AM', field: '鉴定人' },
  ],
  rows: [
    {
      excel_row: 2,
      record_id: null,
      status: 'template',
      values: { 产地3: '模板内容', 鉴定人: '' },
    },
    {
      excel_row: 3,
      record_id: 7,
      status: 'completed',
      values: { 产地3: '梧桐山', 鉴定人: '王五' },
    },
  ],
  completed_count: 1,
  latest_write_row: 3,
  next_write_row: 4,
  last_updated: '2026-08-04T10:00:00',
}

describe('ExcelPreview inline editing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getCurrentTemplate).mockResolvedValue({
      id: 1,
      original_filename: 'template.xlsx',
      target_sheet: '标本表',
      header_row: 1,
      start_row: 2,
      base_write_row: 3,
      style_source_row: 2,
      field_mapping: { 产地3: 'X', 鉴定人: 'AM' },
      is_active: true,
      created_at: '',
    })
    vi.mocked(getPreview).mockResolvedValue(preview)
    vi.mocked(updateRecord).mockResolvedValue({
      id: 7,
      image_filename: '',
      image_path: '',
      image_url: '/api/recognition/7/image',
      processed_image_path: '',
      rotation_degrees: 0,
      status: 'completed',
      extracted_draft: {},
      confirmed_extraction: {},
      taxonomy_result: {},
      warnings: [],
      fields: { 产地3: '深圳湾' },
      created_at: '',
      updated_at: '',
    })
  })

  it('only allows completed record rows to be edited and saves the changed cell', async () => {
    render(
      <ToastProvider>
        <ExcelPreview />
      </ToastProvider>,
    )

    const editableCell = await screen.findByRole('button', { name: 'edit-7-X' })
    expect(screen.queryByRole('button', { name: 'edit-null-X' })).not.toBeInTheDocument()

    fireEvent.doubleClick(editableCell)

    await waitFor(() => {
      expect(updateRecord).toHaveBeenCalledWith(7, { 产地3: '深圳湾' })
    })
    expect(await screen.findByText('已更新第 3 行的“产地3”')).toBeInTheDocument()
  })

  it('allows completed identifier cells to be edited', async () => {
    render(
      <ToastProvider>
        <ExcelPreview />
      </ToastProvider>,
    )

    fireEvent.doubleClick(
      await screen.findByRole('button', { name: 'edit-7-AM' }),
    )

    await waitFor(() => {
      expect(updateRecord).toHaveBeenCalledWith(7, { 鉴定人: '深圳湾' })
    })
  })

  it('scrolls to a distant highlighted row through the grid handle', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({
      excel_row: index + 3,
      record_id: index + 1,
      status: 'completed',
      values: { 产地3: `地点${index + 1}`, 鉴定人: '' },
    }))
    vi.mocked(getPreview).mockResolvedValue({
      ...preview,
      rows,
      completed_count: 501,
      latest_write_row: 503,
      next_write_row: 504,
    })

    render(
      <ToastProvider>
        <ExcelPreview highlightRow={503} />
      </ToastProvider>,
    )

    await waitFor(() => {
      expect(scrollToCell).toHaveBeenCalledWith({ rowIdx: 500 })
    })
  })

  it('reloads when the same highlighted row receives a new revision', async () => {
    const view = render(
      <ToastProvider>
        <ExcelPreview highlightRow={3} refreshRevision={1} />
      </ToastProvider>,
    )
    await waitFor(() => expect(getPreview).toHaveBeenCalled())
    const previousCalls = vi.mocked(getPreview).mock.calls.length

    view.rerender(
      <ToastProvider>
        <ExcelPreview highlightRow={3} refreshRevision={2} />
      </ToastProvider>,
    )

    await waitFor(() => {
      expect(getPreview).toHaveBeenCalledTimes(previousCalls + 1)
    })
  })
})
