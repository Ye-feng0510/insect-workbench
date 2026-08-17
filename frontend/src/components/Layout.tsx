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
import FloatingWhalePet from '@/features/pet/FloatingWhalePet'
import { PetActivityProvider } from '@/features/pet/PetActivityContext'
import ThemeToggle from '@/features/theme/ThemeToggle'
import { WorkbenchThemeProvider } from '@/features/theme/WorkbenchThemeProvider'
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
        <CheckCircle className="h-3 w-3 text-teal-300" />
      ) : (
        <XCircle className="h-3 w-3 text-cyan-100/35" />
      )}
      <span className={ok ? 'text-teal-200' : 'text-cyan-100/45'}>{label}</span>
    </span>
  )
}

export interface LayoutOutletContext {
  refreshTemplateStatus: () => Promise<void>
}

export default function Layout() {
  const location = useLocation()
  const isAgentWorkbench = isAgentWorkbenchPath(location.pathname)
  const isWorkbenchRoute = isAgentWorkbench || location.pathname.startsWith('/workbench')
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
    <WorkbenchThemeProvider>
    <PetActivityProvider>
    <AgentPanelLayoutContext.Provider value={agentPanelLayout}>
    <div
      ref={agentPanelLayout.containerRef}
      className="dsh-app-shell flex h-screen bg-[#f3f7f7] text-[#102c3d]"
    >
      <aside
        id="agent-navigation-panel"
        style={isAgentWorkbench ? { width: agentPanelLayout.leftWidth } : undefined}
        className={`dsh-sidebar flex shrink-0 flex-col border-r border-[#183c4d] bg-[#092b40] text-white shadow-[12px_0_40px_rgba(10,39,56,0.08)] ${
          isAgentWorkbench ? '' : 'w-60'
        }`}
      >
        <div className="flex items-center gap-3 border-b border-white/10 px-5 py-5">
          <div className="dsh-brand-mark flex h-10 w-10 items-center justify-center rounded-2xl">
            <img src="/deepseek-whale.png" alt="" className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <span className="block truncate text-sm font-bold tracking-wide">昆虫标本工作台</span>
            <span className="mt-0.5 block text-[10px] uppercase tracking-[.18em] text-cyan-200/55">Specimen Intelligence</span>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-1.5 p-3">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all ${
                  isActive
                    ? 'bg-white/12 font-semibold text-white shadow-inner shadow-white/5'
                    : 'text-cyan-100/65 hover:bg-white/8 hover:text-white'
                }`
              }
            >
              <Icon className="h-4 w-4 opacity-80 transition group-hover:opacity-100" />
              {label}
            </NavLink>
          ))}
        </nav>
        {user?.role === 'admin' ? (
          <div className="border-t border-white/10 px-4 py-4">
            <label htmlFor="owner-context" className="mb-2 block text-[10px] font-semibold uppercase tracking-[.13em] text-cyan-100/45">
              当前数据所有者
            </label>
            <select
              id="owner-context"
              value={selectedOwnerId ?? user.id}
              onChange={(event) => selectOwner(Number(event.target.value))}
              className="w-full rounded-xl border border-cyan-200/15 bg-white/8 px-2.5 py-2 text-xs font-medium text-cyan-50 outline-none focus:border-cyan-200/40 focus:ring-2 focus:ring-cyan-200/10"
            >
              {adminUsers.length > 0 ? adminUsers.map((owner) => (
                <option key={owner.id} value={owner.id} disabled={!owner.is_active}>
                  {owner.username}{owner.id === user.id ? '（我）' : ''}
                </option>
              )) : (
                <option value={user.id}>{user.username}（我）</option>
              )}
            </select>
            <p className="mt-2 truncate text-[11px] text-cyan-100/40">
              正在管理：{selectedOwner?.username ?? user.username}
            </p>
          </div>
        ) : null}
        <div className="space-y-2 border-t border-white/10 px-5 py-4 text-xs">
          <StatusBadge ok={templateConfigured} label="Excel 模板" />
          {user?.role === 'admin' ? <StatusBadge ok={modelConfigured} label="模型 API" /> : null}
          {!templateConfigured ? (
            <NavLink
              to="/export"
              className="mt-1 block text-xs text-cyan-200/75 hover:text-white hover:underline"
            >
              配置 Excel 模板 &rarr;
            </NavLink>
          ) : null}
          {user?.role === 'admin' && !modelConfigured ? (
            <NavLink
              to="/settings"
              className="block text-xs text-cyan-200/75 hover:text-white hover:underline"
            >
              配置模型 API &rarr;
            </NavLink>
          ) : null}
          <div className="mt-3 flex items-center gap-2 border-t border-white/10 pt-3">
            <ThemeToggle />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-cyan-50">{user?.username}</p>
              <p className="mt-0.5 text-cyan-100/45">
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
              className="rounded-xl p-2 text-cyan-100/45 transition hover:bg-red-400/10 hover:text-red-200"
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
          : 'dsh-main min-w-0 flex-1 overflow-auto bg-[radial-gradient(circle_at_top_right,rgba(62,191,183,0.08),transparent_28rem)] p-6'
      }>
        <Outlet
          key={`${user?.role ?? 'anonymous'}:${selectedOwnerId ?? user?.id ?? ''}`}
          context={{ refreshTemplateStatus } satisfies LayoutOutletContext}
        />
      </main>
      {isWorkbenchRoute ? (
        <FloatingWhalePet safeRight={isAgentWorkbench ? agentPanelLayout.rightWidth + 24 : 28} />
      ) : null}
    </div>
    </AgentPanelLayoutContext.Provider>
    </PetActivityProvider>
    </WorkbenchThemeProvider>
  )
}
