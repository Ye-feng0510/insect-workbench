import { useEffect, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import SettingsPage from './pages/SettingsPage'
import AIWorkbenchPage from './pages/AIWorkbenchPage'
import WorkbenchPage from './pages/WorkbenchPage'
import RecordsPage from './pages/RecordsPage'
import ExportPage from './pages/ExportPage'
import MaterialsPage from './pages/MaterialsPage'
import LoginPage from './pages/LoginPage'
import AdminUsersPage from './pages/AdminUsersPage'
import { PublicOnly, RequireAdmin, RequireAuth } from './components/AuthGuards'
import {
  checkBackendCompatibility,
  EXPECTED_BACKEND_VERSION,
  REQUIRED_BACKEND_CAPABILITY,
  type BackendCompatibility,
} from './services/version'

export default function App() {
  const [compatibility, setCompatibility] = useState<BackendCompatibility | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    let checking = false
    const revalidate = async () => {
      if (checking) return
      checking = true
      try {
        const result = await checkBackendCompatibility()
        if (active) setCompatibility(result)
      } finally {
        checking = false
      }
    }
    const revalidateWhenVisible = () => {
      if (document.visibilityState === 'visible') void revalidate()
    }

    void revalidate()
    const interval = window.setInterval(() => {
      void revalidate()
    }, 5_000)
    window.addEventListener('focus', revalidateWhenVisible)
    document.addEventListener('visibilitychange', revalidateWhenVisible)

    return () => {
      active = false
      window.clearInterval(interval)
      window.removeEventListener('focus', revalidateWhenVisible)
      document.removeEventListener('visibilitychange', revalidateWhenVisible)
    }
  }, [attempt])

  if (compatibility === null) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <p role="status" aria-live="polite" className="text-sm text-slate-600">
          正在检查应用版本兼容性…
        </p>
      </main>
    )
  }

  if (!compatibility.compatible) {
    const retry = () => {
      setCompatibility(null)
      setAttempt((current) => current + 1)
    }
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <section
          role="alert"
          aria-labelledby="compatibility-heading"
          className="w-full max-w-lg rounded-2xl border border-red-200 bg-white p-6 shadow-sm"
        >
          <h1 id="compatibility-heading" className="text-xl font-semibold text-red-700">
            前后端版本不兼容
          </h1>
          <p className="mt-3 text-sm leading-6 text-slate-700">
            当前界面无法安全使用，已停止加载工作台，避免产生错误请求。
          </p>
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 rounded-lg bg-red-50 p-4 text-sm">
            <dt className="font-medium text-slate-700">前端要求</dt>
            <dd className="break-all text-slate-600">{EXPECTED_BACKEND_VERSION}</dd>
            <dt className="font-medium text-slate-700">后端版本</dt>
            <dd className="break-all text-slate-600">
              {compatibility.version ?? '无法读取（可能是旧版本或服务未启动）'}
            </dd>
            <dt className="font-medium text-slate-700">所需能力</dt>
            <dd className="break-all text-slate-600">{REQUIRED_BACKEND_CAPABILITY}</dd>
          </dl>
          <p className="mt-4 text-sm leading-6 text-slate-700">
            请退出应用，重新运行一键更新器，确认前端与后端均更新到
            {' '}
            {EXPECTED_BACKEND_VERSION}
            ，然后重启应用。若仍出现此提示，请联系管理员并提供上述版本信息。
          </p>
          <button
            type="button"
            onClick={retry}
            className="mt-5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2"
          >
            重新检查
          </button>
        </section>
      </main>
    )
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={(
          <PublicOnly>
            <LoginPage />
          </PublicOnly>
        )}
      />
      <Route
        element={(
          <RequireAuth>
            <Layout />
          </RequireAuth>
        )}
      >
        <Route index element={<Navigate to="/agent-workbench" replace />} />
        <Route path="/agent-workbench" element={<AIWorkbenchPage />} />
        <Route path="/workbench" element={<WorkbenchPage />} />
        <Route path="/materials" element={<MaterialsPage />} />
        <Route path="/records" element={<RecordsPage />} />
        <Route path="/export" element={<ExportPage />} />
        <Route
          path="/settings"
          element={(
            <RequireAdmin>
              <SettingsPage />
            </RequireAdmin>
          )}
        />
        <Route
          path="/admin/users"
          element={(
            <RequireAdmin>
              <AdminUsersPage />
            </RequireAdmin>
          )}
        />
        <Route path="*" element={<Navigate to="/agent-workbench" replace />} />
      </Route>
    </Routes>
  )
}
