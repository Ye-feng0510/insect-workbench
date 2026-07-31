import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { ToastProvider } from '@/components/Toast'
import { AuthProvider } from '@/contexts/AuthContext'
import { getCurrentUser, login, logout } from '@/services/auth'
import {
  getQuotaHistory,
  getUsageHistory,
  listUsers,
  setUserQuota,
} from '@/services/adminUsers'
import { getModelConfig } from '@/services/settings'
import { setCsrfToken } from '@/services/api'
import type { AuthUser } from '@/types'

vi.mock('@/services/auth', () => ({
  getCurrentUser: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
}))

vi.mock('@/services/adminUsers', () => ({
  listUsers: vi.fn(),
  createUser: vi.fn(),
  setUserActive: vi.fn(),
  resetUserPassword: vi.fn(),
  setUserQuota: vi.fn(),
  getQuotaHistory: vi.fn(),
  getUsageHistory: vi.fn(),
}))

vi.mock('@/services/settings', () => ({
  getModelConfig: vi.fn(),
}))

vi.mock('@/services/templates', () => ({
  getCurrentTemplate: vi.fn().mockResolvedValue(null),
}))

const { workbenchMounted } = vi.hoisted(() => ({
  workbenchMounted: vi.fn(),
}))
vi.mock('./pages/WorkbenchPage', () => ({
  default: function MockWorkbenchPage() {
    useEffect(() => {
      workbenchMounted()
    }, [])
    return <h1>工作台内容</h1>
  },
}))
vi.mock('./pages/MaterialsPage', () => ({ default: () => <h1>素材内容</h1> }))
vi.mock('./pages/RecordsPage', () => ({ default: () => <h1>记录内容</h1> }))
vi.mock('./pages/ExportPage', () => ({ default: () => <h1>导出内容</h1> }))
vi.mock('./pages/SettingsPage', () => ({ default: () => <h1>设置内容</h1> }))

const ordinaryUser: AuthUser = {
  id: 2,
  username: 'worker',
  role: 'user',
  is_active: true,
  workflow_quota: 10,
  workflow_reserved: 1,
  workflow_charged: 3,
}

const adminUser: AuthUser = {
  id: 1,
  username: 'admin',
  role: 'admin',
  is_active: true,
  workflow_quota: null,
  workflow_reserved: 0,
  workflow_charged: 0,
}

function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  )
}

describe('frontend authentication and RBAC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    workbenchMounted.mockClear()
    sessionStorage.clear()
    vi.mocked(logout).mockResolvedValue()
    vi.mocked(listUsers).mockResolvedValue([adminUser, ordinaryUser])
    vi.mocked(getQuotaHistory).mockResolvedValue([])
    vi.mocked(getUsageHistory).mockResolvedValue([])
    vi.mocked(getModelConfig).mockResolvedValue({
      base_url: '',
      api_key: '',
      model_name: '',
    })
  })

  it('redirects an anonymous user to login and completes login', async () => {
    vi.mocked(getCurrentUser).mockReset()
    vi.mocked(getCurrentUser).mockRejectedValueOnce(new Error('unauthorized'))
    vi.mocked(login).mockResolvedValueOnce(ordinaryUser)
    renderApp('/records')

    expect(await screen.findByRole('heading', { name: '昆虫标本工作台' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'worker' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'long-password' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))

    await waitFor(() => {
      expect(login).toHaveBeenCalledWith('worker', 'long-password')
      expect(screen.getByRole('heading', { name: '记录内容' })).toBeInTheDocument()
    })
  })

  it('hides admin navigation and never requests settings for an ordinary user', async () => {
    vi.mocked(getCurrentUser).mockReset()
    setCsrfToken('existing-session')
    vi.mocked(getCurrentUser).mockResolvedValueOnce(ordinaryUser)
    renderApp('/workbench')

    expect(await screen.findByRole('heading', { name: '工作台内容' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '设置' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '用户管理' })).not.toBeInTheDocument()
    expect(screen.getByText('剩余配额：6')).toBeInTheDocument()
    expect(getModelConfig).not.toHaveBeenCalled()
  })

  it('guards the settings route from an ordinary user', async () => {
    vi.mocked(getCurrentUser).mockReset()
    setCsrfToken('existing-session')
    vi.mocked(getCurrentUser).mockResolvedValueOnce(ordinaryUser)
    renderApp('/settings')

    expect(await screen.findByRole('heading', { name: '工作台内容' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '设置内容' })).not.toBeInTheDocument()
  })

  it('lets an administrator select a user data context and adjust quota', async () => {
    vi.mocked(getCurrentUser).mockReset()
    setCsrfToken('existing-session')
    vi.mocked(getCurrentUser).mockResolvedValueOnce(adminUser)
    vi.mocked(setUserQuota).mockResolvedValueOnce({
      ...ordinaryUser,
      workflow_quota: 25,
    })
    renderApp('/admin/users')

    expect(await screen.findByRole('heading', { name: '用户与配额管理' })).toBeInTheDocument()
    expect(await screen.findByRole('option', { name: 'worker' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('当前数据所有者'), { target: { value: '2' } })
    expect(await screen.findByText('正在管理：worker')).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: '配额与历史' })[1])
    const quotaInput = await screen.findByLabelText('新配额总量')
    fireEvent.change(quotaInput, { target: { value: '25' } })
    fireEvent.change(screen.getByLabelText('配额调整原因'), {
      target: { value: '季度增加' },
    })
    fireEvent.click(screen.getByRole('button', { name: '设置配额总量' }))

    await waitFor(() => {
      expect(setUserQuota).toHaveBeenCalledWith(2, 25, '季度增加')
    })
    expect(screen.getByText('工作流配额：不限')).toBeInTheDocument()
  })

  it('remounts owner-scoped content when an administrator switches owners', async () => {
    vi.mocked(getCurrentUser).mockReset()
    setCsrfToken('existing-session')
    vi.mocked(getCurrentUser).mockResolvedValueOnce(adminUser)
    renderApp('/workbench')

    expect(await screen.findByRole('heading', { name: '工作台内容' })).toBeInTheDocument()
    expect(workbenchMounted).toHaveBeenCalledTimes(1)
    fireEvent.change(await screen.findByLabelText('当前数据所有者'), {
      target: { value: '2' },
    })

    await waitFor(() => {
      expect(screen.getByText('正在管理：worker')).toBeInTheDocument()
      expect(workbenchMounted).toHaveBeenCalledTimes(2)
    })
  })
})
