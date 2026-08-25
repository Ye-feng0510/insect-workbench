import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/Toast'
import { PetActivityProvider } from '@/features/pet/PetActivityContext'
import type { MaterialSummary } from '@/types'
import WorkbenchPage from './WorkbenchPage'

vi.mock('@/services/recognition', () => ({
  extractImage: vi.fn(),
  reExtract: vi.fn(),
  confirmExtraction: vi.fn(),
}))

vi.mock('@/services/draft', () => ({
  getActiveDraft: vi.fn(),
  discardDraft: vi.fn(),
}))

vi.mock('@/services/materials', () => ({
  activateClassicWorkbench: vi.fn().mockResolvedValue(undefined),
  deactivateClassicWorkbench: vi.fn().mockResolvedValue(undefined),
  extractNextMaterial: vi.fn(),
  getMaterialSummary: vi.fn(),
  getNextPreview: vi.fn(),
  getPreviewWindow: vi.fn(),
  getPrefetchStatus: vi.fn(),
  skipMaterial: vi.fn(),
}))

vi.mock('@/components/ExcelPreview', () => ({
  default: () => <div>Excel preview</div>,
}))

vi.mock('@/components/AuthenticatedImage', () => ({
  default: ({ src, alt }: { src: string; alt: string }) => (
    <img src={src} alt={alt} />
  ),
}))

vi.mock('@/services/authenticatedImageCache', () => ({
  clearAuthenticatedImageCache: vi.fn(),
  prefetchAuthenticatedImage: vi.fn().mockResolvedValue(new Blob()),
}))

import { getActiveDraft } from '@/services/draft'
import {
  extractNextMaterial,
  getMaterialSummary,
  getNextPreview,
  getPreviewWindow,
  getPrefetchStatus,
} from '@/services/materials'

const availableSummary: MaterialSummary = {
  batch: {
    id: 1,
    original_filename: 'materials.zip',
    total_count: 150,
    is_active: true,
    created_at: '',
    updated_at: '',
  },
  total_count: 150,
  pending_count: 20,
  processing_count: 0,
  completed_count: 130,
  skipped_count: 0,
  failed_count: 0,
  preprocess_status: 'completed',
  preprocessed_count: 150,
  quota_total: 150,
  quota_charged: 130,
  quota_reserved: 0,
  quota_remaining: 20,
  quota_exhausted: false,
}

const exhaustedSummary: MaterialSummary = {
  ...availableSummary,
  quota_total: 130,
  quota_remaining: 0,
  quota_exhausted: true,
}

function renderPage() {
  return render(
    <PetActivityProvider>
      <ToastProvider>
        <WorkbenchPage />
      </ToastProvider>
    </PetActivityProvider>,
  )
}

describe('WorkbenchPage material preview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getActiveDraft).mockResolvedValue(null)
    vi.mocked(getMaterialSummary).mockResolvedValue(availableSummary)
    vi.mocked(getNextPreview).mockResolvedValue({
      item_id: 131,
      filename: '131.jpg',
      image_url: '/api/materials/image/131?variant=preview',
    })
    vi.mocked(getPreviewWindow).mockResolvedValue({
      batch_id: 1,
      items: [],
    })
    vi.mocked(getPrefetchStatus).mockResolvedValue({
      ready_count: 0,
      running_count: 0,
      failed_count: 0,
      queued_count: 0,
      pending_count: 0,
      target: 20,
    })
  })

  it('keeps the pending image visible when extraction reaches the quota boundary', async () => {
    vi.mocked(extractNextMaterial).mockRejectedValue({
      response: { status: 429, data: { detail: '工作流配额已用尽' } },
    })
    vi.mocked(getMaterialSummary)
      .mockResolvedValueOnce(availableSummary)
      .mockResolvedValue(exhaustedSummary)

    renderPage()

    const image = await screen.findByRole('img', { name: '131.jpg' })
    expect(image).toHaveAttribute(
      'src',
      '/api/materials/image/131?variant=preview',
    )

    fireEvent.click(
      screen.getByRole('button', { name: '开始识别这张素材' }),
    )

    expect(
      (await screen.findAllByText(/当前素材和图片已保留/)).length,
    ).toBeGreaterThan(0)
    expect(screen.getByRole('img', { name: '131.jpg' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '开始识别这张素材' }),
    ).toBeDisabled()
  })

  it('shows an explicit quota state without discarding the pending preview', async () => {
    vi.mocked(getMaterialSummary).mockResolvedValue(exhaustedSummary)

    renderPage()

    await waitFor(() => {
      expect(screen.getByText(/工作流配额已用尽（已计费 130/)).toBeInTheDocument()
    })
    expect(
      await screen.findByRole('img', { name: '131.jpg' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('分类信息将在确认图片信息后自动生成')).not.toBeInTheDocument()
  })
})
