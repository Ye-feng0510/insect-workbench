import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/Toast'
import { getExportSummary, exportExcel } from '@/services/export'
import type { TemplateInfo } from '@/types'
import ExportPage from './ExportPage'

vi.mock('@/services/export', () => ({
  getExportSummary: vi.fn(),
  exportExcel: vi.fn(),
}))

vi.mock('@/components/TemplateSettings', () => ({
  default: ({ onTemplateChange }: { onTemplateChange?: (template: TemplateInfo) => void }) => (
    <div>
      <button
        onClick={() => onTemplateChange?.({
          id: 2,
          original_filename: 'new.xlsx',
          target_sheet: '',
          header_row: 1,
          start_row: 2,
          base_write_row: 0,
          style_source_row: 2,
          field_mapping: {},
          is_active: true,
          created_at: '',
        })}
      >
        模拟上传模板
      </button>
      <button
        onClick={() => onTemplateChange?.({
          id: 2,
          original_filename: 'new.xlsx',
          target_sheet: 'Sheet1',
          header_row: 1,
          start_row: 2,
          base_write_row: 4,
          style_source_row: 2,
          field_mapping: { 中名: 'A', 图像: 'B' },
          is_active: true,
          created_at: '',
        })}
      >
        模拟保存映射
      </button>
    </div>
  ),
}))

const summary = {
  completed_count: 3,
  awaiting_confirmation_count: 1,
  template_name: 'current.xlsx',
  target_sheet: 'Sheet1',
  start_write_row: 4,
}

function renderPage(refreshTemplateStatus = vi.fn().mockResolvedValue(undefined)) {
  render(
    <MemoryRouter initialEntries={['/export']}>
      <ToastProvider>
        <Routes>
          <Route element={<Outlet context={{ refreshTemplateStatus }} />}>
            <Route path="/export" element={<ExportPage />} />
          </Route>
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  )
  return refreshTemplateStatus
}

describe('ExportPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getExportSummary).mockResolvedValue(summary)
    vi.mocked(exportExcel).mockResolvedValue({
      filename: 'result.xlsx',
      download_url: '/api/export/download/result.xlsx',
      record_count: 3,
    })
  })

  it('将模板配置和导出汇总显示在同一页面', async () => {
    renderPage()

    expect(screen.getByRole('heading', { name: 'Excel 模板与导出' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Excel 模板配置' })).toBeInTheDocument()
    expect(await screen.findByText('current.xlsx')).toBeInTheDocument()
  })

  it('上传未配置模板后清除旧汇总并刷新全局状态', async () => {
    const refreshTemplateStatus = renderPage()
    await screen.findByText('current.xlsx')

    fireEvent.click(screen.getByRole('button', { name: '模拟上传模板' }))

    await waitFor(() => {
      expect(refreshTemplateStatus).toHaveBeenCalledTimes(1)
      expect(screen.queryByText('current.xlsx')).not.toBeInTheDocument()
    })
    expect(screen.getByText('保存 Excel 模板字段映射后，将在这里显示导出汇总。')).toBeInTheDocument()
  })

  it('保存字段映射后重新加载导出汇总', async () => {
    const refreshTemplateStatus = renderPage()
    await screen.findByText('current.xlsx')

    fireEvent.click(screen.getByRole('button', { name: '模拟保存映射' }))

    await waitFor(() => {
      expect(refreshTemplateStatus).toHaveBeenCalledTimes(1)
      expect(getExportSummary).toHaveBeenCalledTimes(2)
    })
  })
})
