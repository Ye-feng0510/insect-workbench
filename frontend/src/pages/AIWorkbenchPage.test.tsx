import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/Toast'
import type { MaterialItemInfo, MaterialSummary } from '@/types'
import type { WorkflowDetail } from '@/services/workflows'
import AIWorkbenchPage from './AIWorkbenchPage'

vi.mock('@/services/workflows', () => ({
  getActiveWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  resolveTaxonomy: vi.fn(),
  postWorkflowMessage: vi.fn(),
  retryTaxonomy: vi.fn(),
  commitWorkflow: vi.fn(),
}))

vi.mock('@/services/draft', () => ({
  getActiveDraft: vi.fn(),
  discardDraft: vi.fn(),
}))

vi.mock('@/services/materials', () => ({
  extractNextMaterial: vi.fn(),
  getMaterialSummary: vi.fn(),
  getNextPreview: vi.fn(),
  listMaterialItems: vi.fn(),
  skipMaterial: vi.fn(),
}))

vi.mock('@/services/recognition', () => ({
  extractImage: vi.fn(),
  reExtract: vi.fn(),
}))

vi.mock('@/components/ExcelPreview', () => ({
  default: ({
    highlightRow,
    refreshRevision,
  }: {
    highlightRow?: number | null
    refreshRevision?: number
  }) => (
    <div data-testid="excel-preview">
      Excel preview row={highlightRow ?? 'none'} revision={refreshRevision}
    </div>
  ),
}))

vi.mock('@/components/AuthenticatedImage', () => ({
  default: ({ src, alt }: { src: string; alt: string }) => (
    <img src={src} alt={alt} />
  ),
}))

import { discardDraft, getActiveDraft } from '@/services/draft'
import {
  extractNextMaterial,
  getMaterialSummary,
  getNextPreview,
  listMaterialItems,
  skipMaterial,
} from '@/services/materials'
import {
  commitWorkflow,
  getActiveWorkflow,
  getWorkflow,
  postWorkflowMessage,
  resolveTaxonomy,
} from '@/services/workflows'
import { reExtract } from '@/services/recognition'

const emptySummary: MaterialSummary = {
  batch: null,
  total_count: 0,
  pending_count: 0,
  processing_count: 0,
  completed_count: 0,
  skipped_count: 0,
  failed_count: 0,
  quota_total: 100,
  quota_charged: 0,
  quota_reserved: 0,
  quota_remaining: 100,
  quota_exhausted: false,
}

const batchSummary: MaterialSummary = {
  ...emptySummary,
  batch: {
    id: 8,
    original_filename: 'batch.zip',
    total_count: 3,
    is_active: true,
    created_at: '',
    updated_at: '',
  },
  total_count: 3,
  pending_count: 2,
  processing_count: 1,
}

const baseWorkflow: WorkflowDetail = {
  record_id: 21,
  revision: 1,
  status: 'awaiting_confirmation',
  image_filename: 'current.jpg',
  image_url: '/api/recognition/21/image',
  material_item_id: 2,
  recognition: {
    confirmed: {
      中名: '虎甲',
      产地3: '深圳',
      图像: 'IMG-021',
      采集人: '王同学',
      采集日期: '2026-08-01',
      鉴定人: '',
      标签学名: 'Cicindela chinensis',
      命名人: 'De Geer',
    },
    confidence: { 中名: 'high' },
    evidence: {
      中名: '虎甲',
      产地3: '深圳西丽果场',
      图像: 'IMG-021',
    },
  },
  messages: [],
}

const taxonomyWorkflow: WorkflowDetail = {
  ...baseWorkflow,
  status: 'taxonomy_review',
  taxonomy: {
    proposal: {
      Phylum: 'Arthropoda',
      纲: '昆虫纲',
      Class: 'Insecta',
      Order: 'Coleoptera',
      中文科名: '虎甲科',
      科名: 'Cicindelidae',
      属名: 'Cicindela',
      种名: 'chinensis',
      亚科: 'Cicindelinae',
      族: 'Cicindelini',
      亚属: 'Cicindela',
    },
    verification_status: 'verified',
    provenance: '由 Catalogue of Life 与原始标签交叉核验',
    sources: [
      { title: 'Catalogue of Life', url: 'https://www.catalogueoflife.org/' },
    ],
  },
}

const materialItems: MaterialItemInfo[] = [
  {
    id: 1,
    batch_id: 8,
    sequence: 1,
    original_filename: 'first.jpg',
    archive_path: '',
    status: 'completed',
    record_id: 20,
    error_message: '',
    created_at: '',
    updated_at: '',
  },
  {
    id: 2,
    batch_id: 8,
    sequence: 2,
    original_filename: 'current.jpg',
    archive_path: '',
    status: 'processing',
    record_id: 21,
    error_message: '',
    created_at: '',
    updated_at: '',
  },
  {
    id: 3,
    batch_id: 8,
    sequence: 3,
    original_filename: 'last.jpg',
    archive_path: '',
    status: 'pending',
    record_id: null,
    error_message: '',
    created_at: '',
    updated_at: '',
  },
]

function renderPage() {
  return render(
    <ToastProvider>
      <AIWorkbenchPage />
    </ToastProvider>,
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

describe('AIWorkbenchPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getActiveWorkflow).mockResolvedValue(null)
    vi.mocked(getActiveDraft).mockResolvedValue(null)
    vi.mocked(getMaterialSummary).mockResolvedValue(emptySummary)
    vi.mocked(listMaterialItems).mockResolvedValue([])
    vi.mocked(getNextPreview).mockResolvedValue(null)
    vi.mocked(getWorkflow).mockResolvedValue(baseWorkflow)
  })

  it('confirms extracted label fields with the scientific name and authorship', async () => {
    vi.mocked(getActiveWorkflow).mockResolvedValue(baseWorkflow)
    vi.mocked(resolveTaxonomy).mockResolvedValue(taxonomyWorkflow)

    renderPage()

    fireEvent.click(await screen.findByRole('button', {
      name: '确认标签信息并解析分类',
    }))

    await waitFor(() => {
      expect(resolveTaxonomy).toHaveBeenCalledWith(21, expect.objectContaining({
        confirmed: expect.objectContaining({
          中名: '虎甲',
          图像: 'IMG-021',
        }),
        scientific_name: 'Cicindela chinensis',
        authorship: 'De Geer',
      }))
    })
  })

  it('uses the selected rotation and rejects concurrent material extraction', async () => {
    const extraction = deferred<Awaited<ReturnType<typeof extractNextMaterial>>>()
    vi.mocked(getMaterialSummary).mockResolvedValue(batchSummary)
    vi.mocked(getNextPreview).mockResolvedValue({
      item_id: 3,
      filename: 'last.jpg',
      image_url: '/api/materials/image/3',
    })
    vi.mocked(extractNextMaterial).mockReturnValue(extraction.promise)

    renderPage()

    await screen.findByRole('img', { name: 'last.jpg' })
    fireEvent.click(screen.getByRole('button', { name: '顺时针旋转图片' }))
    const start = screen.getByRole('button', { name: '开始识别这张素材' })
    fireEvent.click(start)
    fireEvent.click(start)

    expect(extractNextMaterial).toHaveBeenCalledTimes(1)
    expect(extractNextMaterial).toHaveBeenCalledWith(90)

    extraction.resolve({
      record_id: 22,
      status: 'awaiting_confirmation',
      image_url: '/api/recognition/22/image',
      extracted: { 中名: '步甲', 图像: 'IMG-022' },
      confidence: {},
      evidence: {},
      warnings: [],
      material_item_id: 3,
      batch_id: 8,
      original_filename: 'last.jpg',
      pending_count: 1,
    })
    await screen.findByRole('textbox', { name: '中名' })
  })

  it('sends the selected rotation when re-extracting the active draft', async () => {
    vi.mocked(getActiveWorkflow).mockResolvedValue(baseWorkflow)
    vi.mocked(reExtract).mockResolvedValue({
      record_id: 21,
      status: 'awaiting_confirmation',
      image_url: '/api/recognition/21/image',
      extracted: {
        中名: '虎甲',
        图像: 'IMG-021',
        标签学名: 'Cicindela chinensis',
        命名人: 'De Geer',
      },
      confidence: {},
      evidence: {},
      warnings: [],
    })

    renderPage()

    fireEvent.click(await screen.findByRole('button', {
      name: '顺时针旋转图片',
    }))
    fireEvent.click(screen.getByRole('button', { name: '重新识别' }))

    await waitFor(() => {
      expect(reExtract).toHaveBeenCalledWith(21, 90)
    })
  })

  it('locks edits and terminal actions while re-extraction is pending', async () => {
    const extraction = deferred<Awaited<ReturnType<typeof reExtract>>>()
    vi.mocked(getActiveWorkflow).mockResolvedValue(taxonomyWorkflow)
    vi.mocked(reExtract).mockReturnValue(extraction.promise)

    renderPage()

    const commonName = await screen.findByRole('textbox', { name: '中名' })
    fireEvent.click(screen.getByRole('button', { name: '重新识别' }))

    await waitFor(() => {
      expect(commonName).toBeDisabled()
      expect(screen.getByRole('textbox', { name: '属名' })).toBeDisabled()
      expect(screen.getByRole('textbox', { name: '人工覆盖说明' })).toBeDisabled()
      expect(screen.getByRole('textbox', { name: '解释性消息' })).toBeDisabled()
      expect(screen.getByRole('button', {
        name: '明确确认并写入 Excel',
      })).toBeDisabled()
      expect(screen.getByRole('button', { name: '跳过' })).toBeDisabled()
      expect(screen.getByRole('button', { name: '放弃' })).toBeDisabled()
    })

    fireEvent.click(screen.getByRole('button', {
      name: '明确确认并写入 Excel',
    }))
    fireEvent.click(screen.getByRole('button', { name: '跳过' }))
    fireEvent.click(screen.getByRole('button', { name: '放弃' }))
    expect(commitWorkflow).not.toHaveBeenCalled()
    expect(skipMaterial).not.toHaveBeenCalled()
    expect(discardDraft).not.toHaveBeenCalled()

    extraction.resolve({
      record_id: 21,
      status: 'awaiting_confirmation',
      image_url: '/api/recognition/21/image',
      extracted: { 中名: '新虎甲', 图像: 'IMG-NEW' },
      confidence: {},
      evidence: {},
      warnings: [],
    })
    await waitFor(() => expect(commonName).toBeEnabled())
  })

  it('does not auto-advance an old owner component after unmount', async () => {
    const commit = deferred<Awaited<ReturnType<typeof commitWorkflow>>>()
    vi.mocked(getActiveWorkflow).mockResolvedValue(taxonomyWorkflow)
    vi.mocked(getMaterialSummary).mockResolvedValue(batchSummary)
    vi.mocked(listMaterialItems).mockResolvedValue(materialItems)
    vi.mocked(commitWorkflow).mockReturnValue(commit.promise)

    const page = renderPage()
    fireEvent.click(await screen.findByRole('button', {
      name: '明确确认并写入 Excel',
    }))
    await waitFor(() => expect(commitWorkflow).toHaveBeenCalledTimes(1))

    page.unmount()
    commit.resolve({
      record_id: 21,
      status: 'completed',
      excel_row: 42,
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(extractNextMaterial).not.toHaveBeenCalled()
  })

  it('locks editable workflow fields while taxonomy resolution is pending', async () => {
    const resolution = deferred<WorkflowDetail>()
    vi.mocked(getActiveWorkflow).mockResolvedValue(taxonomyWorkflow)
    vi.mocked(resolveTaxonomy).mockReturnValue(resolution.promise)

    renderPage()

    const commonName = await screen.findByRole('textbox', { name: '中名' })
    const genus = screen.getByRole('textbox', { name: '属名' })
    fireEvent.click(screen.getByRole('button', {
      name: '重新确认并解析分类',
    }))

    await waitFor(() => {
      expect(commonName).toBeDisabled()
      expect(genus).toBeDisabled()
      expect(screen.getByRole('textbox', { name: '人工覆盖说明' })).toBeDisabled()
      expect(screen.getByRole('button', {
        name: '明确确认并写入 Excel',
      })).toBeDisabled()
      expect(screen.getByRole('button', { name: '重新识别' })).toBeDisabled()
      expect(screen.getByRole('button', { name: '跳过' })).toBeDisabled()
      expect(screen.getByRole('button', { name: '放弃' })).toBeDisabled()
    })

    fireEvent.click(screen.getByRole('button', {
      name: '明确确认并写入 Excel',
    }))
    fireEvent.click(screen.getByRole('button', { name: '重新识别' }))
    fireEvent.click(screen.getByRole('button', { name: '跳过' }))
    fireEvent.click(screen.getByRole('button', { name: '放弃' }))
    expect(commitWorkflow).not.toHaveBeenCalled()
    expect(reExtract).not.toHaveBeenCalled()
    expect(skipMaterial).not.toHaveBeenCalled()
    expect(discardDraft).not.toHaveBeenCalled()

    resolution.resolve(taxonomyWorkflow)
    await waitFor(() => expect(commonName).toBeEnabled())
  })

  it('restores nested backend extraction without empty record fields overwriting it', async () => {
    vi.mocked(getActiveWorkflow).mockResolvedValue({
      id: 7,
      record_id: 21,
      state: 'awaiting_confirmation',
      record: {
        id: 21,
        status: 'awaiting_confirmation',
        image_filename: 'current.jpg',
        image_url: '/api/recognition/21/image',
        extracted_draft: {
          extracted: baseWorkflow.recognition?.confirmed,
          confidence: { 中名: 'high' },
        },
        fields: {
          中名: '',
          图像: '',
          采集人: '',
          Phylum: '',
          科名: '',
          属名: '',
        },
      },
      messages: [],
    })
    vi.mocked(resolveTaxonomy).mockResolvedValue(taxonomyWorkflow)

    renderPage()

    expect(await screen.findByRole('textbox', { name: '中名' })).toHaveValue('虎甲')
    expect(screen.getByRole('textbox', { name: '图像' })).toHaveValue('IMG-021')
    expect(screen.getByRole('textbox', { name: '标签学名' })).toHaveValue(
      'Cicindela chinensis',
    )
    const confirmButton = screen.getByRole('button', {
      name: '确认标签信息并解析分类',
    })
    expect(confirmButton).toBeEnabled()
    fireEvent.click(confirmButton)
    await waitFor(() => {
      expect(resolveTaxonomy).toHaveBeenCalledWith(21, expect.objectContaining({
        confirmed: expect.not.objectContaining({
          Phylum: expect.anything(),
          科名: expect.anything(),
          属名: expect.anything(),
        }),
      }))
    })
  })

  it('keeps the verbatim confirmed label ahead of the accepted name', async () => {
    vi.mocked(getActiveWorkflow).mockResolvedValue({
      ...taxonomyWorkflow,
      scientific_name: 'Cicindela campestris',
      record: {
        confirmed_extraction: {
          confirmed: {
            ...(baseWorkflow.recognition?.confirmed as Record<string, string>),
            标签学名: 'Cicindela chinensis De Geer',
          },
        },
        fields: {
          标签学名: 'Cicindela chinensis De Geer',
        },
      },
      resolution: {
        accepted_scientific_name: 'Cicindela campestris',
        proposal: {},
      },
    })

    renderPage()

    expect(await screen.findByRole('textbox', { name: '标签学名' })).toHaveValue(
      'Cicindela chinensis De Geer',
    )
  })

  it('shows provenance, source links, and an unresolved warning', async () => {
    vi.mocked(getActiveWorkflow).mockResolvedValue({
      ...taxonomyWorkflow,
      taxonomy: {
        ...taxonomyWorkflow.taxonomy as object,
        verification_status: 'unresolved',
      },
    })

    renderPage()

    expect(await screen.findByLabelText('产地3原文证据')).toHaveTextContent(
      '深圳西丽果场',
    )
    fireEvent.click(await screen.findByRole('tab', { name: '证据' }))
    expect(screen.getByText('标签识别原文')).toBeInTheDocument()
    expect(screen.getByText('深圳西丽果场')).toBeInTheDocument()
    expect(screen.getByText('由 Catalogue of Life 与原始标签交叉核验')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Catalogue of Life/ })).toHaveAttribute(
      'href',
      'https://www.catalogueoflife.org/',
    )
    expect(screen.getByRole('alert')).toHaveTextContent('分类尚未解决')
  })

  it('does not commit taxonomy until the explicit commit action is used', async () => {
    vi.mocked(getActiveWorkflow).mockResolvedValue(taxonomyWorkflow)

    renderPage()

    const genus = await screen.findByRole('textbox', { name: '属名' })
    fireEvent.change(genus, { target: { value: 'Cylindera' } })

    expect(commitWorkflow).not.toHaveBeenCalled()
    expect(screen.getByRole('button', {
      name: '明确确认并写入 Excel',
    })).toBeEnabled()
  })

  it('only invalidates taxonomy when a recognition field affects taxonomy', async () => {
    vi.mocked(getActiveWorkflow).mockResolvedValue(taxonomyWorkflow)

    renderPage()

    const commit = await screen.findByRole('button', {
      name: '明确确认并写入 Excel',
    })
    fireEvent.change(screen.getByRole('textbox', { name: '鉴定人' }), {
      target: { value: '普通用户灰度员' },
    })
    expect(commit).toBeEnabled()
    expect(screen.queryByText('你修改了上游标签，必须重新查询分类后才能提交。'))
      .not.toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox', { name: '中名' }), {
      target: { value: '草蛉' },
    })
    expect(commit).toBeDisabled()
    expect(screen.getByText('你修改了上游标签，必须重新查询分类后才能提交。'))
      .toBeInTheDocument()
  })

  it('posts explanatory chat without committing or mutating fields', async () => {
    vi.mocked(getActiveWorkflow).mockResolvedValue(taxonomyWorkflow)
    vi.mocked(postWorkflowMessage).mockResolvedValue({
      ...taxonomyWorkflow,
      messages: [
        { id: 8, role: 'user', content: '为什么是这个属？' },
        { id: 9, role: 'assistant', content: '该建议来自两个来源的交叉核验。' },
      ],
    })

    renderPage()

    const before = await screen.findByRole('textbox', { name: '属名' })
    expect(before).toHaveValue('Cicindela')
    fireEvent.change(before, { target: { value: 'Cylindera' } })
    fireEvent.change(screen.getByRole('textbox', { name: '解释性消息' }), {
      target: { value: '为什么是这个属？' },
    })
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))

    await waitFor(() => {
      expect(postWorkflowMessage).toHaveBeenCalledWith(21, '为什么是这个属？')
    })
    expect(commitWorkflow).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: '属名' })).toHaveValue('Cylindera')
    expect(await screen.findByText('该建议来自两个来源的交叉核验。')).toBeInTheDocument()
  })

  it('shows every material status and highlights the current item', async () => {
    vi.mocked(getActiveWorkflow).mockResolvedValue(baseWorkflow)
    vi.mocked(getMaterialSummary).mockResolvedValue(batchSummary)
    vi.mocked(listMaterialItems).mockResolvedValue(materialItems)

    renderPage()

    fireEvent.click(await screen.findByRole('tab', { name: '素材' }))
    expect(await screen.findByText('first.jpg')).toBeInTheDocument()
    expect(screen.getAllByText('current.jpg').length).toBeGreaterThan(0)
    expect(screen.getByText('last.jpg')).toBeInTheDocument()
    expect(screen.getByText('已完成')).toBeInTheDocument()
    expect(screen.getByText('处理中')).toBeInTheDocument()
    expect(screen.getByText('待处理')).toBeInTheDocument()
    expect(
      screen.getAllByText('current.jpg').some(
        (element) => Boolean(element.closest('[aria-current="true"]')),
      ),
    ).toBe(true)
  })

  it('keeps the pending material preview visible after a quota 429', async () => {
    const exhaustedSummary = {
      ...batchSummary,
      quota_charged: 100,
      quota_remaining: 0,
      quota_exhausted: true,
    }
    vi.mocked(getMaterialSummary)
      .mockResolvedValueOnce(batchSummary)
      .mockResolvedValue(exhaustedSummary)
    vi.mocked(getNextPreview).mockResolvedValue({
      item_id: 3,
      filename: 'last.jpg',
      image_url: '/api/materials/image/3',
    })
    vi.mocked(extractNextMaterial).mockRejectedValue({
      response: { status: 429, data: { detail: 'quota exhausted' } },
    })

    renderPage()

    const preview = await screen.findByRole('img', { name: 'last.jpg' })
    expect(preview).toHaveAttribute('src', '/api/materials/image/3')
    fireEvent.click(screen.getByRole('button', { name: '开始识别这张素材' }))

    await screen.findByText(/工作流配额已用尽（已计费 100/)
    expect(screen.getByRole('img', { name: 'last.jpg' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始识别这张素材' })).toBeDisabled()
  })

  it('refreshes Excel and automatically advances the queue after commit', async () => {
    vi.mocked(getActiveWorkflow).mockResolvedValue(taxonomyWorkflow)
    vi.mocked(getMaterialSummary).mockResolvedValue(batchSummary)
    vi.mocked(listMaterialItems).mockResolvedValue(materialItems)
    vi.mocked(commitWorkflow).mockResolvedValue({
      record_id: 21,
      status: 'completed',
      excel_row: 42,
    })
    vi.mocked(extractNextMaterial).mockResolvedValue({
      record_id: 22,
      status: 'awaiting_confirmation',
      image_url: '/api/recognition/22/image',
      extracted: { 中名: '步甲', 图像: 'IMG-022' },
      confidence: {},
      evidence: {},
      warnings: [],
      material_item_id: 3,
      batch_id: 8,
      original_filename: 'last.jpg',
      pending_count: 1,
    })
    vi.mocked(getWorkflow).mockResolvedValue({
      ...baseWorkflow,
      record_id: 22,
      image_filename: 'last.jpg',
      image_url: '/api/recognition/22/image',
      material_item_id: 3,
    })

    renderPage()
    fireEvent.change(await screen.findByRole('textbox', { name: '鉴定人' }), {
      target: { value: '普通用户灰度员' },
    })
    fireEvent.click(await screen.findByRole('button', {
      name: '明确确认并写入 Excel',
    }))

    await waitFor(() => {
      expect(commitWorkflow).toHaveBeenCalledWith(21, expect.objectContaining({
        expected_revision: 1,
        confirmed: expect.objectContaining({ 鉴定人: '普通用户灰度员' }),
        taxonomy: expect.objectContaining({ 属名: 'Cicindela' }),
      }))
      expect(extractNextMaterial).toHaveBeenCalledTimes(1)
    })
    fireEvent.click(screen.getByRole('tab', { name: 'Excel' }))
    expect(screen.getByTestId('excel-preview')).toHaveTextContent(
      'row=42 revision=1',
    )
    fireEvent.click(screen.getByRole('tab', { name: '图片' }))
    expect(await screen.findByRole('img', { name: 'last.jpg' })).toHaveAttribute(
      'src',
      '/api/recognition/22/image',
    )
  })

  it('recovers the active workflow and its messages on reload', async () => {
    vi.mocked(getActiveWorkflow).mockResolvedValue({
      id: 7,
      record_id: 21,
      state: 'awaiting_taxonomy_confirmation',
      material_item_id: 2,
      scientific_name: 'Cicindela chinensis',
      scientific_name_authorship: 'De Geer',
      subfamily: 'Cicindelinae',
      record: {
        id: 21,
        status: 'awaiting_taxonomy_confirmation',
        image_filename: 'current.jpg',
        image_url: '/api/recognition/21/image',
        rotation_degrees: 0,
        confirmed_extraction: {
          中名: '虎甲',
          图像: 'IMG-021',
        },
        extracted_draft: {
          confidence: { 中名: 'high' },
        },
      },
      resolution: {
        proposal: {
          Phylum: 'Arthropoda',
          纲: '昆虫纲',
          Class: 'Insecta',
          Order: 'Coleoptera',
          中文科名: '虎甲科',
          科名: 'Cicindelidae',
          属名: 'Cicindela',
          种名: 'chinensis',
        },
        verification_level: 'authoritative_match',
        provenance: {
          provider: 'GBIF',
          dataset: 'GBIF Backbone Taxonomy',
          source_url: 'https://www.gbif.org/species/1',
        },
        conflicts: [],
      },
      messages: [
        { id: 1, actor: 'user', content: { text: '请解释来源' } },
        { id: 2, actor: 'assistant', content: { text: '来源是 GBIF' } },
      ],
    })

    renderPage()

    expect(await screen.findByDisplayValue('Cicindela chinensis')).toBeInTheDocument()
    expect(screen.getByText('请解释来源')).toBeInTheDocument()
    expect(screen.getByText('来源是 GBIF')).toBeInTheDocument()
    expect(screen.getAllByText('权威来源已核验').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('tab', { name: '证据' }))
    expect(screen.getByRole('link', { name: /GBIF/ })).toHaveAttribute(
      'href',
      'https://www.gbif.org/species/1',
    )
    expect(getActiveWorkflow).toHaveBeenCalledTimes(1)
  })
})
