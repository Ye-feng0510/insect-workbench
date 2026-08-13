import { createContext, useContext } from 'react'
import type { AuthUser } from '@/types'

export interface AuthContextValue {
  user: AuthUser | null
  loading: boolean
  adminUsers: AuthUser[]
  selectedOwnerId: number | null
  selectedOwner: AuthUser | null
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  refreshUser: () => Promise<void>
  refreshAdminUsers: () => Promise<void>
  selectOwner: (ownerId: number) => void
  clearSelectedOwner: () => void
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return context
}
