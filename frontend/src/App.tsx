import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import LoginPage from './pages/LoginPage'
import { PublicOnly, RequireAdmin, RequireAuth } from './components/AuthGuards'
import {
  checkBackendCompatibility,
  EXPECTED_BACKEND_VERSION,
  isConnectivityIssue,
  REQUIRED_BACKEND_CAPABILITY,
  type BackendCompatibility,
} from './services/version'

const SettingsPage = lazy(() => import('./pages/SettingsPage'))
const AIWorkbenchPage = lazy(() => import('./pages/AIWorkbenchPage'))
const WorkbenchPage = lazy(() => import('./pages/WorkbenchPage'))
const RecordsPage = lazy(() => import('./pages/RecordsPage'))
const ExportPage = lazy(() => import('./pages/ExportPage'))
const MaterialsPage = lazy(() => import('./pages/MaterialsPage'))
const AdminUsersPage = lazy(() => import('./pages/AdminUsersPage'))

function LazyPage({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="p-6 text-sm text-gray-500">正在加载页面…</div>}>{children}</Suspense>
}

export default function App() {
  const [compatibility, setCompatibility] = useState<BackendCompatibility | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    let checking = false
    // 去抖:连续失败若干次才判定为不可达,避免单次网络抖动卸载整个应用
    let consecutiveFailures = 0
    let lastGood: BackendCompatibility | null = null
    const FAILURE_THRESHOLD = 3
    // 成功后降频轮询(30s),失败后恢复 5s 快速重试,显著降低常态请求量
    let pollMs = 5_000
    let timer: number | undefined

    const schedule = (ms: number) => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        void revalidate()
      }, ms)
    }

    const revalidate = async () => {
      if (checking) return
      checking = true
      try {
        const result = await checkBackendCompatibility()
        if (!active) return
        if (result.compatible) {
          consecutiveFailures = 0
          lastGood = result
          pollMs = 30_000
          setCompatibility(result)
          schedule(pollMs)
        } else if (isConnectivityIssue(result.reason) && lastGood?.compatible) {
          // 曾验证过兼容、当前仅瞬时不可达:保持应用可用,静默快速重试
          consecutiveFailures += 1
          if (consecutiveFailures < FAILURE_THRESHOLD) {
            schedule(5_000)
          } else {
            // 持续不可达:切换到重连页(非"不兼容"红屏)
            setCompatibility(result)
            schedule(5_000)
          }
        } else {
          // 真正的版本/能力不匹配:立即展示,保持快速轮询等待后端更新
          setCompatibility(result)
          schedule(5_000)
        }
      } finally {
        checking = false
      }
    }
    const revalidateWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        if (timer !== undefined) window.clearTimeout(timer)
        void revalidate()
      }
    }

    void revalidate()
    window.addEventListener('focus', revalidateWhenVisible)
    document.addEventListener('visibilitychange', revalidateWhenVisible)

    return () => {
      active = false
      if (timer !== undefined) window.clearTimeout(timer)
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
    if (isConnectivityIssue(compatibility.reason)) {
      // 不可达 ≠ 版本不兼容:温和重连页,自动轮询恢复,不误导用户
      return (
        <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
          <section
            role="status"
            aria-labelledby="reconnect-heading"
            className="w-full max-w-lg rounded-2xl border border-amber-200 bg-white p-6 shadow-sm"
          >
            <h1 id="reconnect-heading" className="text-xl font-semibold text-amber-700">
              正在连接后端服务…
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-700">
              暂时无法连接到服务器,可能是服务正在重启或网络波动。
              页面将自动重试,恢复后会自动返回,无需手动操作。
            </p>
            <button
              type="button"
              onClick={retry}
              className="mt-5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2"
            >
              立即重试
            </button>
          </section>
        </main>
      )
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
            网页版用户请刷新页面（Ctrl+F5 强制刷新）以获取新版本；
            便携版用户请退出应用并重新运行一键更新器，确认前端与后端均更新到
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
        <Route index element={<Navigate to="/workbench" replace />} />
        <Route path="/agent-workbench" element={<LazyPage><AIWorkbenchPage /></LazyPage>} />
        <Route path="/workbench" element={<LazyPage><WorkbenchPage /></LazyPage>} />
        <Route path="/materials" element={<LazyPage><MaterialsPage /></LazyPage>} />
        <Route path="/records" element={<LazyPage><RecordsPage /></LazyPage>} />
        <Route path="/export" element={<LazyPage><ExportPage /></LazyPage>} />
        <Route
          path="/settings"
          element={(
            <RequireAdmin>
            <LazyPage><SettingsPage /></LazyPage>
            </RequireAdmin>
          )}
        />
        <Route
          path="/admin/users"
          element={(
            <RequireAdmin>
            <LazyPage><AdminUsersPage /></LazyPage>
            </RequireAdmin>
          )}
        />
        <Route path="*" element={<Navigate to="/workbench" replace />} />
      </Route>
    </Routes>
  )
}
