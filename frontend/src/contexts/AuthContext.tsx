import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useToast } from '@/components/Toast'
import { getCurrentUser, login as loginRequest, logout as logoutRequest } from '@/services/auth'
import { listUsers } from '@/services/adminUsers'
import {
  configureOwnerHeader,
  hasSessionHint,
  setCsrfToken,
} from '@/services/api'
import type { AuthUser } from '@/types'
import { AuthContext, type AuthContextValue } from './auth'

const OWNER_STORAGE_KEY = 'insect-selected-owner'

function persistedOwnerId(): number | null {
  const raw = sessionStorage.getItem(OWNER_STORAGE_KEY)
  if (!raw) return null
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { show } = useToast()
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [adminUsers, setAdminUsers] = useState<AuthUser[]>([])
  const [selectedOwnerId, setSelectedOwnerId] = useState<number | null>(null)
  const [ownerReady, setOwnerReady] = useState(false)
  const authGenerationRef = useRef(0)

  const clearAuth = useCallback(() => {
    authGenerationRef.current += 1
    setUser(null)
    setAdminUsers([])
    setSelectedOwnerId(null)
    setOwnerReady(false)
    sessionStorage.removeItem(OWNER_STORAGE_KEY)
    setCsrfToken(null)
    configureOwnerHeader(false, null)
    setLoading(false)
  }, [])

  const applyUser = useCallback((nextUser: AuthUser) => {
    setUser(nextUser)
    if (nextUser.role !== 'admin') {
      setAdminUsers([])
      setSelectedOwnerId(null)
      setOwnerReady(true)
      sessionStorage.removeItem(OWNER_STORAGE_KEY)
      configureOwnerHeader(false, null)
      return
    }
    const ownerId = persistedOwnerId() ?? nextUser.id
    setOwnerReady(false)
    setSelectedOwnerId(ownerId)
    configureOwnerHeader(true, ownerId)
  }, [])

  const refreshUser = useCallback(async () => {
    const generation = authGenerationRef.current
    const current = await getCurrentUser()
    if (generation === authGenerationRef.current) {
      applyUser(current)
    }
  }, [applyUser])

  const refreshAdminUsers = useCallback(async () => {
    if (user?.role !== 'admin') return
    const generation = authGenerationRef.current
    let users: AuthUser[]
    try {
      users = await listUsers()
    } catch {
      if (generation !== authGenerationRef.current) return
      setAdminUsers([user])
      setSelectedOwnerId(user.id)
      sessionStorage.setItem(OWNER_STORAGE_KEY, String(user.id))
      configureOwnerHeader(true, user.id)
      setOwnerReady(true)
      show('用户列表加载失败，已切换到管理员自己的数据', 'error')
      return
    }
    if (generation !== authGenerationRef.current) return
    setAdminUsers(users)
    setSelectedOwnerId((current) => {
      const valid = users.some((item) => item.id === current && item.is_active)
      const next = valid ? current : user.id
      sessionStorage.setItem(OWNER_STORAGE_KEY, String(next))
      configureOwnerHeader(true, next)
      return next
    })
    setOwnerReady(true)
  }, [show, user])

  useEffect(() => {
    if (!hasSessionHint()) {
      clearAuth()
      setLoading(false)
      return
    }
    const generation = authGenerationRef.current
    getCurrentUser()
      .then((current) => {
        if (generation === authGenerationRef.current) applyUser(current)
      })
      .catch(() => {
        if (generation === authGenerationRef.current) clearAuth()
      })
      .finally(() => {
        if (generation === authGenerationRef.current) setLoading(false)
      })
  }, [applyUser, clearAuth])

  useEffect(() => {
    if (user?.role === 'admin') {
      void refreshAdminUsers()
    }
  }, [refreshAdminUsers, user?.role])

  useEffect(() => {
    const handleUnauthorized = () => {
      clearAuth()
      if (location.pathname !== '/login') {
        navigate('/login', {
          replace: true,
          state: { from: location.pathname },
        })
      }
    }
    const handleForbidden = (event: Event) => {
      const detail = (event as CustomEvent<{ detail?: string }>).detail
      show(detail?.detail ?? '没有权限执行此操作', 'error')
    }
    const handleQuotaChanged = () => {
      void refreshUser().catch(handleUnauthorized)
    }
    window.addEventListener('auth:unauthorized', handleUnauthorized)
    window.addEventListener('auth:forbidden', handleForbidden)
    window.addEventListener('auth:quota-changed', handleQuotaChanged)
    return () => {
      window.removeEventListener('auth:unauthorized', handleUnauthorized)
      window.removeEventListener('auth:forbidden', handleForbidden)
      window.removeEventListener('auth:quota-changed', handleQuotaChanged)
    }
  }, [clearAuth, location.pathname, navigate, refreshUser, show])

  const login = useCallback(async (username: string, password: string) => {
    const generation = authGenerationRef.current + 1
    authGenerationRef.current = generation
    const loggedInUser = await loginRequest(username, password)
    if (generation === authGenerationRef.current) {
      applyUser(loggedInUser)
    }
  }, [applyUser])

  const logout = useCallback(async () => {
    authGenerationRef.current += 1
    try {
      await logoutRequest()
    } finally {
      clearAuth()
      navigate('/login', { replace: true })
    }
  }, [clearAuth, navigate])

  const selectOwner = useCallback((ownerId: number) => {
    if (user?.role !== 'admin') return
    if (!adminUsers.some((item) => item.id === ownerId && item.is_active)) return
    setSelectedOwnerId(ownerId)
    sessionStorage.setItem(OWNER_STORAGE_KEY, String(ownerId))
    configureOwnerHeader(true, ownerId)
  }, [adminUsers, user?.role])

  const selectedOwner = adminUsers.find((item) => item.id === selectedOwnerId)
    ?? (user?.id === selectedOwnerId ? user : null)

  const value = useMemo<AuthContextValue>(() => ({
    user,
    loading: loading || (user?.role === 'admin' && !ownerReady),
    adminUsers,
    selectedOwnerId,
    selectedOwner,
    login,
    logout,
    refreshUser,
    refreshAdminUsers,
    selectOwner,
  }), [
    adminUsers,
    loading,
    login,
    logout,
    ownerReady,
    refreshAdminUsers,
    refreshUser,
    selectOwner,
    selectedOwner,
    selectedOwnerId,
    user,
  ])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
