import { useState, useEffect, useCallback } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { Microscope, Images, Table, Download, Settings, CheckCircle, XCircle } from 'lucide-react'
import { getModelConfig } from '@/services/settings'
import { getCurrentTemplate } from '@/services/templates'

const navItems = [
  { to: '/workbench', label: '识别工作台', icon: Microscope },
  { to: '/materials', label: '数据素材图片', icon: Images },
  { to: '/records', label: '记录管理', icon: Table },
  { to: '/export', label: '模板与导出', icon: Download },
  { to: '/settings', label: '设置', icon: Settings },
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
  const [modelConfigured, setModelConfigured] = useState(false)
  const [templateConfigured, setTemplateConfigured] = useState(false)

  const refreshTemplateStatus = useCallback(async () => {
    try {
      const template = await getCurrentTemplate()
      setTemplateConfigured(Boolean(template?.is_active && template.target_sheet))
    } catch {
      setTemplateConfigured(false)
    }
  }, [])

  useEffect(() => {
    getModelConfig()
      .then((model) => setModelConfigured(Boolean(model.base_url && model.model_name)))
      .catch(() => setModelConfigured(false))
    void refreshTemplateStatus()
  }, [refreshTemplateStatus])

  return (
    <div className="flex h-screen bg-gray-50 text-gray-800">
      <aside className="flex w-60 shrink-0 flex-col border-r border-gray-200 bg-white">
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
        <div className="space-y-1.5 border-t border-gray-200 px-5 py-3 text-xs">
          <StatusBadge ok={templateConfigured} label="Excel 模板" />
          <StatusBadge ok={modelConfigured} label="模型 API" />
          {!templateConfigured ? (
            <NavLink
              to="/export"
              className="mt-1 block text-xs text-blue-500 hover:underline"
            >
              配置 Excel 模板 &rarr;
            </NavLink>
          ) : null}
          {!modelConfigured ? (
            <NavLink
              to="/settings"
              className="block text-xs text-blue-500 hover:underline"
            >
              配置模型 API &rarr;
            </NavLink>
          ) : null}
        </div>
      </aside>
      <main className="flex-1 overflow-auto p-6">
        <Outlet context={{ refreshTemplateStatus } satisfies LayoutOutletContext} />
      </main>
    </div>
  )
}
