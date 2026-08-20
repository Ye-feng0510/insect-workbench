import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { checkBackendCompatibility } from './services/version'

vi.mock('./services/version', () => ({
  EXPECTED_BACKEND_VERSION: 'v1.2.1',
  REQUIRED_BACKEND_CAPABILITY: 'agent_workflows_v1',
  checkBackendCompatibility: vi.fn(),
  isConnectivityIssue: (reason: string) => reason === 'unreachable',
}))

const { workflowMounted } = vi.hoisted(() => ({
  workflowMounted: vi.fn(),
}))
vi.mock('./components/AuthGuards', () => ({
  PublicOnly: () => null,
  RequireAdmin: () => null,
  RequireAuth: function MockAuthenticatedApplication() {
    workflowMounted()
    return <h1>工作台内容</h1>
  },
}))
vi.mock('./pages/AIWorkbenchPage', () => ({
  default: function MockWorkflowPage() {
    workflowMounted()
    return <h1>工作台内容</h1>
  },
}))

describe('application compatibility gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('blocks application routes on mismatch and offers a retry action', async () => {
    vi.mocked(checkBackendCompatibility).mockResolvedValue({
      compatible: false,
      reason: 'version_mismatch',
      version: '1.1.0',
      capabilities: ['agent_workflows_v1'],
    })

    render(
      <MemoryRouter initialEntries={['/agent-workbench']}>
        <App />
      </MemoryRouter>,
    )

    expect(screen.getByRole('status')).toHaveTextContent('正在检查应用版本兼容性')
    expect(
      await screen.findByRole('heading', { name: '前后端版本不兼容' }),
    ).toBeInTheDocument()
    expect(screen.getByText('1.1.0')).toBeInTheDocument()
    // 修正后的指引:网页用户刷新页面,便携版用户运行更新器
    expect(screen.getByText(/刷新页面/)).toBeInTheDocument()
    expect(screen.getByText(/一键更新器/)).toBeInTheDocument()
    expect(workflowMounted).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '重新检查' }))

    await waitFor(() => {
      expect(checkBackendCompatibility).toHaveBeenCalledTimes(2)
    })
    expect(workflowMounted).not.toHaveBeenCalled()
  })

  it('explains that an old health response cannot provide a backend version', async () => {
    vi.mocked(checkBackendCompatibility).mockResolvedValue({
      compatible: false,
      reason: 'missing_metadata',
      version: null,
      capabilities: [],
    })

    render(
      <MemoryRouter initialEntries={['/agent-workbench']}>
        <App />
      </MemoryRouter>,
    )

    expect(
      await screen.findByText('无法读取（可能是旧版本或服务未启动）'),
    ).toBeInTheDocument()
    expect(workflowMounted).not.toHaveBeenCalled()
  })

  it('revalidates a loaded application and blocks it after backend replacement', async () => {
    vi.mocked(checkBackendCompatibility)
      .mockResolvedValueOnce({
        compatible: true,
        version: 'v1.2.1',
        capabilities: ['agent_workflows_v1'],
      })
      .mockResolvedValueOnce({
        compatible: false,
        reason: 'version_mismatch',
        version: 'v1.2.0',
        capabilities: ['agent_workflows_v1'],
      })

    render(
      <MemoryRouter initialEntries={['/agent-workbench']}>
        <App />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('heading', { name: '工作台内容' })).toBeInTheDocument()

    fireEvent.focus(window)

    expect(
      await screen.findByRole('heading', { name: '前后端版本不兼容' }),
    ).toBeInTheDocument()
    expect(checkBackendCompatibility).toHaveBeenCalledTimes(2)
  })

  it('shows a reconnect page instead of incompatibility when unreachable', async () => {
    vi.mocked(checkBackendCompatibility).mockResolvedValue({
      compatible: false,
      reason: 'unreachable',
      version: null,
      capabilities: [],
    })

    render(
      <MemoryRouter initialEntries={['/agent-workbench']}>
        <App />
      </MemoryRouter>,
    )

    // 不可达显示温和重连页,而不是"前后端版本不兼容"红屏
    expect(
      await screen.findByRole('heading', { name: '正在连接后端服务…' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '前后端版本不兼容' })).not.toBeInTheDocument()
    expect(workflowMounted).not.toHaveBeenCalled()
  })

  it('keeps the app usable through transient unreachable after a successful check', async () => {
    vi.mocked(checkBackendCompatibility)
      .mockResolvedValueOnce({
        compatible: true,
        version: 'v1.2.1',
        capabilities: ['agent_workflows_v1'],
      })
      // 此后持续不可达(服务重启场景)
      .mockResolvedValue({
        compatible: false,
        reason: 'unreachable',
        version: null,
        capabilities: [],
      })

    render(
      <MemoryRouter initialEntries={['/agent-workbench']}>
        <App />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('heading', { name: '工作台内容' })).toBeInTheDocument()

    // 触发一次可见性重验证 -> 首次不可达:应用应保持可用(去抖,阈值 3 次内不切换)
    fireEvent.focus(window)
    await waitFor(() => {
      expect(checkBackendCompatibility).toHaveBeenCalledTimes(2)
    })

    // 短暂等待:确认没有立即切换到任何错误页
    await new Promise((resolve) => { setTimeout(resolve, 100) })
    expect(screen.getByRole('heading', { name: '工作台内容' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '前后端版本不兼容' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '正在连接后端服务…' })).not.toBeInTheDocument()
  })
})
