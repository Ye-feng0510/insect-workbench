import { useState, useEffect, useCallback, useRef } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  Microscope,
  MessageSquare,
  Images,
  Table,
  Download,
  Settings,
  CheckCircle,
  XCircle,
  LogOut,
  Users,
} from 'lucide-react'
import { getModelConfig } from '@/services/settings'
import { getCurrentTemplate } from '@/services/templates'
import { useAuth } from '@/contexts/auth'
import PanelResizeHandle from '@/features/workbench/PanelResizeHandle'
import {
  AgentPanelLayoutContext,
  isAgentWorkbenchPath,
  useAgentPanelLayout,
} from '@/features/workbench/panel-layout'

const businessNavItems = [
  { to: '/agent-workbench', label: '智能体工作台', icon: MessageSquare },
  { to: '/workbench', label: '经典识别工作台', icon: Microscope },
  { to: '/materials', label: '数据素材图片', icon: Images },
  { to: '/records', label: '记录管理', icon: Table },
  { to: '/export', label: '模板与导出', icon: Download },
]

interface StatusBadgeProps {
  ok: boolean
  label: string
}

function StatusBadge({ ok, label }: StatusBadgeProps) {
  return (
    <span className="flex items-center gap-1">
      {ok ? (
        <CheckCircle className="h-3 w-3 text-emerald-500" />
      ) : (
        <XCircle className="h-3 w-3 text-gray-300" />
      )}
      <span className={ok ? 'text-emerald-600' : 'text-gray-400'}>{label}</span>
    </span>
  )
}

export interface LayoutOutletContext {
  refreshTemplateStatus: () => Promise<void>
}

export default function Layout() {
  const location = useLocation()
  const isAgentWorkbench = isAgentWorkbenchPath(location.pathname)
  const agentPanelLayout = useAgentPanelLayout()
  const {
    user,
    adminUsers,
    selectedOwnerId,
    selectedOwner,
    selectOwner,
    logout,
  } = useAuth()
  const [modelConfigured, setModelConfigured] = useState(false)
  const [templateConfigured, setTemplateConfigured] = useState(false)
  const templateRequestRef = useRef(0)

  const refreshTemplateStatus = useCallback(async () => {
    const requestId = ++templateRequestRef.current
    try {
      const template = await getCurrentTemplate()
      if (requestId === templateRequestRef.current) {
        setTemplateConfigured(Boolean(template?.is_active && template.target_sheet))
      }
    } catch {
      if (requestId === templateRequestRef.current) {
        setTemplateConfigured(false)
      }
    }
  }, [])

  useEffect(() => {
    if (user?.role === 'admin') {
      getModelConfig()
        .then((model) => setModelConfigured(Boolean(model.base_url && model.model_name)))
        .catch(() => setModelConfigured(false))
    } else {
      setModelConfigured(false)
    }
    void refreshTemplateStatus()
  }, [refreshTemplateStatus, selectedOwnerId, user?.role])

  const navItems = user?.role === 'admin'
    ? [
        ...businessNavItems,
        { to: '/admin/users', label: '用户管理', icon: Users },
        { to: '/settings', label: '设置', icon: Settings },
      ]
    : businessNavItems

  return (
    <AgentPanelLayoutContext.Provider value={agentPanelLayout}>
    <div
      ref={agentPanelLayout.containerRef}
      className="flex h-screen bg-gray-50 text-gray-800"
    >
      <aside
        id="agent-navigation-panel"
        style={isAgentWorkbench ? { width: agentPanelLayout.leftWidth } : undefined}
        className={`flex shrink-0 flex-col border-r border-gray-200 bg-white ${
          isAgentWorkbench ? '' : 'w-60'
        }`}
      >
        <div className="flex items-center gap-2 border-b border-gray-200 px-5 py-4">
          <Microscope className="h-6 w-6 text-emerald-600" />
          <span className="text-base font-semibold">昆虫标本工作台</span>
        </div>
        <nav className="flex flex-1 flex-col gap-1 p-3">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? 'bg-emerald-50 font-medium text-emerald-700'
                    : 'text-gray-600 hover:bg-gray-100'
                }`
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        {user?.role === 'admin' ? (
          <div className="border-t border-gray-200 px-4 py-3">
            <label htmlFor="owner-context" className="mb-1 block text-xs font-medium text-gray-500">
              当前数据所有者
            </label>
            <select
              id="owner-context"
              value={selectedOwnerId ?? user.id}
              onChange={(event) => selectOwner(Number(event.target.value))}
              className="w-full rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-xs font-medium text-emerald-700"
            >
              {adminUsers.length > 0 ? adminUsers.map((owner) => (
                <option key={owner.id} value={owner.id} disabled={!owner.is_active}>
                  {owner.username}{owner.id === user.id ? '（我）' : ''}
                </option>
              )) : (
                <option value={user.id}>{user.username}（我）</option>
              )}
            </select>
            <p className="mt-1 truncate text-xs text-gray-400">
              正在管理：{selectedOwner?.username ?? user.username}
            </p>
          </div>
        ) : null}
        <div className="space-y-1.5 border-t border-gray-200 px-5 py-3 text-xs">
          <StatusBadge ok={templateConfigured} label="Excel 模板" />
          {user?.role === 'admin' ? <StatusBadge ok={modelConfigured} label="模型 API" /> : null}
          {!templateConfigured ? (
            <NavLink
              to="/export"
              className="mt-1 block text-xs text-blue-500 hover:underline"
            >
              配置 Excel 模板 &rarr;
            </NavLink>
          ) : null}
          {user?.role === 'admin' && !modelConfigured ? (
            <NavLink
              to="/settings"
              className="block text-xs text-blue-500 hover:underline"
            >
              配置模型 API &rarr;
            </NavLink>
          ) : null}
          <div className="mt-2 flex items-center justify-between border-t border-gray-100 pt-2">
            <div className="min-w-0">
              <p className="truncate font-medium text-gray-600">{user?.username}</p>
              <p className="text-gray-400">
                {user?.role === 'admin'
                  ? '工作流配额：不限'
                  : `剩余配额：${Math.max(
                      0,
                      (user?.workflow_quota ?? 0)
                        - (user?.workflow_charged ?? 0)
                        - (user?.workflow_reserved ?? 0),
                    )}`}
              </p>
            </div>
            <button
              onClick={() => void logout()}
              title="退出登录"
              aria-label="退出登录"
              className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-red-500"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>
      {isAgentWorkbench ? (
        <PanelResizeHandle
          side="left"
          currentWidth={agentPanelLayout.leftWidth}
          maxWidth={agentPanelLayout.leftMax}
          active={agentPanelLayout.draggingSide === 'left'}
          onPointerDown={(event) => agentPanelLayout.startResize('left', event)}
          onWidthChange={(width) => agentPanelLayout.setSideWidth('left', width)}
          onReset={agentPanelLayout.reset}
        />
      ) : null}
      <main className={
        isAgentWorkbench
          ? 'min-w-0 flex-1 overflow-hidden'
          : 'min-w-0 flex-1 overflow-auto p-6'
      }>
        <Outlet
          key={`${user?.role ?? 'anonymous'}:${selectedOwnerId ?? user?.id ?? ''}`}
          context={{ refreshTemplateStatus } satisfies LayoutOutletContext}
        />
      </main>
    </div>
    </AgentPanelLayoutContext.Provider>
  )
}
