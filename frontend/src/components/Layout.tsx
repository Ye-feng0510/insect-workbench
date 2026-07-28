import { NavLink, Outlet } from 'react-router-dom'
import { Microscope, Table, Download, Settings } from 'lucide-react'

const navItems = [
  { to: '/workbench', label: '识别工作台', icon: Microscope },
  { to: '/records', label: '记录管理', icon: Table },
  { to: '/export', label: 'Excel 导出', icon: Download },
  { to: '/settings', label: '设置', icon: Settings },
]

export default function Layout() {
  return (
    <div className="flex h-screen bg-gray-50 text-gray-800">
      <aside className="flex w-60 flex-col border-r border-gray-200 bg-white">
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
        <div className="border-t border-gray-200 px-5 py-3 text-xs text-gray-400">
          <p>模板: <span className="text-gray-500">未加载</span></p>
          <p>模型: <span className="text-gray-500">未配置</span></p>
          <p>API: <span className="text-gray-400">未知</span></p>
        </div>
      </aside>
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  )
}
