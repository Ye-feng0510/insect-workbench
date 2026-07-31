import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import {
  CheckCircle2,
  History,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  UserRoundCog,
} from 'lucide-react'
import { useAuth } from '@/contexts/auth'
import { useToast } from '@/components/Toast'
import {
  createUser,
  getQuotaHistory,
  getUsageHistory,
  resetUserPassword,
  setUserActive,
  setUserQuota,
} from '@/services/adminUsers'
import type { AuthUser, QuotaAdjustment, WorkflowUsage } from '@/types'
import { extractErrorMessage } from '@/types'

export default function AdminUsersPage() {
  const {
    user,
    adminUsers,
    selectedOwnerId,
    selectOwner,
    refreshAdminUsers,
  } = useAuth()
  const { show } = useToast()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [initialQuota, setInitialQuota] = useState('100')
  const [creating, setCreating] = useState(false)
  const [busyUserId, setBusyUserId] = useState<number | null>(null)
  const [detailUserId, setDetailUserId] = useState<number | null>(null)
  const [quotaTotal, setQuotaTotal] = useState('')
  const [quotaReason, setQuotaReason] = useState('')
  const [resetPassword, setResetPassword] = useState('')
  const [historyLoading, setHistoryLoading] = useState(false)
  const [quotaHistory, setQuotaHistory] = useState<QuotaAdjustment[]>([])
  const [usageHistory, setUsageHistory] = useState<WorkflowUsage[]>([])
  const historyRequestRef = useRef(0)

  useEffect(() => {
    void refreshAdminUsers().catch((error) => {
      show(extractErrorMessage(error, '加载用户失败'), 'error')
    })
  }, [refreshAdminUsers, show])

  const detailUser = useMemo(
    () => adminUsers.find((item) => item.id === detailUserId) ?? null,
    [adminUsers, detailUserId],
  )

  const loadHistory = useCallback(async (userId: number | null) => {
    const requestId = ++historyRequestRef.current
    if (!userId) {
      setQuotaHistory([])
      setUsageHistory([])
      setHistoryLoading(false)
      return
    }
    setQuotaHistory([])
    setUsageHistory([])
    setHistoryLoading(true)
    return Promise.all([
      getQuotaHistory(userId),
      getUsageHistory(userId),
    ])
      .then(([quota, usage]) => {
        if (requestId === historyRequestRef.current) {
          setQuotaHistory(quota)
          setUsageHistory(usage)
        }
      })
      .catch((error) => {
        if (requestId === historyRequestRef.current) {
          show(extractErrorMessage(error, '加载历史失败'), 'error')
        }
      })
      .finally(() => {
        if (requestId === historyRequestRef.current) setHistoryLoading(false)
      })
  }, [show])

  useEffect(() => {
    void loadHistory(detailUserId)
  }, [detailUserId, loadHistory])

  const reload = async () => {
    const userId = detailUserId
    await refreshAdminUsers()
    await loadHistory(userId)
  }

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault()
    setCreating(true)
    try {
      await createUser({
        username: username.trim(),
        password,
        role: 'user',
        workflow_quota: Number(initialQuota),
      })
      setUsername('')
      setPassword('')
      setInitialQuota('100')
      await refreshAdminUsers()
      show('用户已创建', 'success')
    } catch (error) {
      show(extractErrorMessage(error, '创建用户失败'), 'error')
    } finally {
      setCreating(false)
    }
  }

  const handleToggleActive = async (target: AuthUser) => {
    setBusyUserId(target.id)
    try {
      await setUserActive(target.id, !target.is_active)
      await refreshAdminUsers()
      show(target.is_active ? '用户已停用' : '用户已启用', 'success')
    } catch (error) {
      show(extractErrorMessage(error, '更新用户状态失败'), 'error')
    } finally {
      setBusyUserId(null)
    }
  }

  const handleSetQuota = async (event: FormEvent) => {
    event.preventDefault()
    if (!detailUser) return
    setBusyUserId(detailUser.id)
    try {
      await setUserQuota(detailUser.id, Number(quotaTotal), quotaReason.trim())
      setQuotaTotal('')
      setQuotaReason('')
      await reload()
      show('配额总量已更新', 'success')
    } catch (error) {
      show(extractErrorMessage(error, '更新配额失败'), 'error')
    } finally {
      setBusyUserId(null)
    }
  }

  const handleResetPassword = async (event: FormEvent) => {
    event.preventDefault()
    if (!detailUser) return
    setBusyUserId(detailUser.id)
    try {
      await resetUserPassword(detailUser.id, resetPassword)
      setResetPassword('')
      show('密码已重置', 'success')
    } catch (error) {
      show(extractErrorMessage(error, '重置密码失败'), 'error')
    } finally {
      setBusyUserId(null)
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-800">用户与配额管理</h1>
        <p className="mt-1 text-sm text-gray-400">
          管理普通用户，并明确选择要查看或操作的数据所有者。
        </p>
      </div>

      <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="mb-4 flex items-center gap-2 text-base font-semibold text-gray-700">
          <Plus className="h-4 w-4 text-emerald-600" />
          创建普通用户
        </h2>
        <form className="grid gap-3 md:grid-cols-4" onSubmit={handleCreate}>
          <input
            aria-label="新用户名"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="用户名"
            required
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <input
            aria-label="初始密码"
            type="password"
            minLength={12}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="初始密码（至少 12 位）"
            required
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <input
            aria-label="初始配额总量"
            type="number"
            min="0"
            value={initialQuota}
            onChange={(event) => setInitialQuota(event.target.value)}
            required
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={creating}
            className="flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            创建用户
          </button>
        </form>
      </section>

      <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <h2 className="flex items-center gap-2 font-semibold text-gray-700">
            <UserRoundCog className="h-4 w-4 text-emerald-600" />
            用户列表
          </h2>
          <button
            onClick={() => void refreshAdminUsers()}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-emerald-600"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-5 py-3">用户</th>
                <th className="px-5 py-3">角色</th>
                <th className="px-5 py-3">状态</th>
                <th className="px-5 py-3">配额（已用 / 总量 / 剩余）</th>
                <th className="px-5 py-3">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {adminUsers.map((target) => (
                <tr key={target.id} className={selectedOwnerId === target.id ? 'bg-emerald-50/50' : ''}>
                  <td className="px-5 py-3 font-medium text-gray-700">{target.username}</td>
                  <td className="px-5 py-3 text-gray-500">
                    {target.role === 'admin' ? '管理员' : '普通用户'}
                  </td>
                  <td className="px-5 py-3">
                    <span className={target.is_active ? 'text-emerald-600' : 'text-red-500'}>
                      {target.is_active ? '已启用' : '已停用'}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-gray-500">
                    {target.role === 'admin'
                      ? '不限'
                      : `${target.workflow_charged} / ${target.workflow_quota ?? 0} / ${Math.max(
                          0,
                          (target.workflow_quota ?? 0)
                            - target.workflow_charged
                            - target.workflow_reserved,
                        )}`}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => selectOwner(target.id)}
                        disabled={!target.is_active}
                        className="rounded-md border border-emerald-200 px-2 py-1 text-xs text-emerald-700 disabled:opacity-40"
                      >
                        {selectedOwnerId === target.id ? '当前数据上下文' : '管理该用户数据'}
                      </button>
                      <button
                        onClick={() => {
                          setDetailUserId(target.id)
                          setQuotaTotal(target.workflow_quota === null ? '' : String(target.workflow_quota))
                        }}
                        className="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600"
                      >
                        配额与历史
                      </button>
                      {target.id !== user?.id ? (
                        <button
                          onClick={() => void handleToggleActive(target)}
                          disabled={busyUserId === target.id}
                          className="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 disabled:opacity-40"
                        >
                          {target.is_active ? '停用' : '启用'}
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {detailUser ? (
        <section className="space-y-5 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-semibold text-gray-700">
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
              {detailUser.username} 的配额与安全
            </h2>
            <button
              onClick={() => setDetailUserId(null)}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              关闭
            </button>
          </div>
          {detailUser.role === 'user' ? (
            <form className="grid gap-3 md:grid-cols-3" onSubmit={handleSetQuota}>
              <input
                aria-label="新配额总量"
                type="number"
                min="0"
                value={quotaTotal}
                onChange={(event) => setQuotaTotal(event.target.value)}
                placeholder="新配额总量"
                required
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
              <input
                aria-label="配额调整原因"
                value={quotaReason}
                onChange={(event) => setQuotaReason(event.target.value)}
                placeholder="调整原因"
                required
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
              <button
                type="submit"
                disabled={busyUserId === detailUser.id}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                设置配额总量
              </button>
            </form>
          ) : (
            <p className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-600">管理员配额不限。</p>
          )}
          <form className="grid gap-3 md:grid-cols-3" onSubmit={handleResetPassword}>
            <input
              aria-label="新密码"
              type="password"
              minLength={12}
              value={resetPassword}
              onChange={(event) => setResetPassword(event.target.value)}
              placeholder="新密码（至少 12 位）"
              required
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm md:col-span-2"
            />
            <button
              type="submit"
              disabled={busyUserId === detailUser.id}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 disabled:opacity-50"
            >
              重置密码
            </button>
          </form>
          <div>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-600">
              <History className="h-4 w-4" />
              配额调整历史
            </h3>
            {historyLoading ? <Loader2 className="h-4 w-4 animate-spin text-emerald-600" /> : (
              <div className="space-y-1 text-xs text-gray-500">
                {quotaHistory.length === 0 ? <p>暂无配额调整记录</p> : quotaHistory.map((item) => (
                  <p key={item.id}>
                    {item.created_at}：{item.old_quota ?? '不限'} → {item.new_quota ?? '不限'}（{item.reason}）
                  </p>
                ))}
              </div>
            )}
          </div>
          <div>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-600">
              <History className="h-4 w-4" />
              工作流使用明细
            </h3>
            {historyLoading ? <Loader2 className="h-4 w-4 animate-spin text-emerald-600" /> : (
              <div className="max-h-40 space-y-1 overflow-y-auto text-xs text-gray-500">
                {usageHistory.length === 0 ? <p>暂无使用记录</p> : usageHistory.map((item) => (
                  <p key={item.id}>
                    记录 #{item.record_id ?? '-'}：{
                      item.status === 'charged'
                        ? '已核销'
                        : item.status === 'reserved'
                          ? '已预留'
                          : '已释放'
                    }（{item.charged_at ?? item.released_at ?? item.reserved_at}）
                  </p>
                ))}
              </div>
            )}
          </div>
          <p className="flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500">
            <CheckCircle2 className="h-4 w-4" />
            当前已计费 {detailUser.workflow_charged} 次，预留 {detailUser.workflow_reserved} 次。
          </p>
        </section>
      ) : null}
    </div>
  )
}
