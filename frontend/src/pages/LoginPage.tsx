import { useState, type FormEvent } from 'react'
import { Loader2, LockKeyhole, Microscope } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '@/contexts/auth'
import { extractErrorMessage } from '@/types'

export default function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      await login(username.trim(), password)
      const from = (location.state as { from?: string } | null)?.from
      navigate(from && from !== '/login' ? from : '/agent-workbench', { replace: true })
    } catch (requestError) {
      setError(extractErrorMessage(requestError, '登录失败，请检查用户名和密码'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        <div className="mb-7 flex flex-col items-center">
          <div className="mb-3 rounded-xl bg-emerald-50 p-3">
            <Microscope className="h-8 w-8 text-emerald-600" />
          </div>
          <h1 className="text-xl font-semibold text-gray-800">昆虫标本工作台</h1>
          <p className="mt-1 text-sm text-gray-400">登录后继续使用</p>
        </div>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div>
            <label htmlFor="username" className="mb-1 block text-sm font-medium text-gray-600">
              用户名
            </label>
            <input
              id="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
              autoFocus
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </div>
          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium text-gray-600">
              密码
            </label>
            <div className="relative">
              <LockKeyhole className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                className="w-full rounded-lg border border-gray-300 py-2.5 pl-9 pr-3 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
          </div>
          {error ? (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={submitting || !username.trim() || !password}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            登录
          </button>
        </form>
      </div>
    </main>
  )
}
