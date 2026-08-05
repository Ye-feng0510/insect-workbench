import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import Loading from './Loading'
import { useAuth } from '@/contexts/auth'

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return <Loading />
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  return children
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <Loading />
  if (!user) return <Navigate to="/login" replace />
  if (user.role !== 'admin') return <Navigate to="/agent-workbench" replace />
  return children
}

export function PublicOnly({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return <Loading />
  if (user) {
    const from = (location.state as { from?: string } | null)?.from
    return <Navigate to={from && from !== '/login' ? from : '/agent-workbench'} replace />
  }
  return children
}
