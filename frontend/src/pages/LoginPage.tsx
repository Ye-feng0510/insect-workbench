import { useState, type FormEvent } from 'react'
import { ArrowRight, Loader2, LockKeyhole, ShieldCheck } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '@/contexts/auth'
import { extractErrorMessage } from '@/types'
import OceanBackground from '@/components/brand/OceanBackground'
import type { LoginScenePhase } from '@/features/login/CinematicLoginScene'

export default function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const scenePhase: LoginScenePhase = error
    ? 'error'
    : submitting
      ? 'submitting'
      : username || password
        ? 'editing'
        : 'idle'

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
    <OceanBackground phase={scenePhase}>
      <main className="login-card">
        <div className="login-card__header">
          <div className="login-card__brand">
            <div className="login-card__mark">
              <img src="/deepseek-whale.png" alt="" />
            </div>
            <div>
              <p className="login-card__kicker">Specimen Lab</p>
              <h1>昆虫标本工作台</h1>
            </div>
          </div>
          <p className="login-card__intro">登录智能体工作台，继续你的标本识别与知识归档。</p>
        </div>
        <form className="login-form" onSubmit={handleSubmit}>
          <div>
            <label htmlFor="username" className="login-form__label">
              用户名
            </label>
            <input
              id="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
              autoFocus
              className="login-form__input login-form__input--plain"
            />
          </div>
          <div>
            <label htmlFor="password" className="login-form__label">
              密码
            </label>
            <div className="login-form__field">
              <LockKeyhole className="login-form__icon" />
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                className="login-form__input login-form__input--icon"
              />
            </div>
          </div>
          {error ? (
            <p role="alert" className="login-form__error">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            aria-label="登录"
            disabled={submitting || !username.trim() || !password}
            className="login-form__submit"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {submitting ? '正在进入工作台…' : '进入智能体工作台'}
            {!submitting ? <ArrowRight className="h-4 w-4" /> : null}
          </button>
        </form>
        <div className="login-form__trust">
          <ShieldCheck />
          <span>本地会话加密 · 数据归属隔离</span>
        </div>
      </main>
    </OceanBackground>
  )
}
