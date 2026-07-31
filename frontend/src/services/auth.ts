import api, { setCsrfToken } from './api'
import type { AuthUser, LoginResponse } from '@/types'

export async function login(username: string, password: string): Promise<AuthUser> {
  const { data } = await api.post<LoginResponse>('/auth/login', { username, password })
  setCsrfToken(data.csrf_token ?? null)
  return data.user
}

export async function logout(): Promise<void> {
  await api.post('/auth/logout')
  setCsrfToken(null)
}

export async function getCurrentUser(): Promise<AuthUser> {
  const { data } = await api.get<AuthUser | { user: AuthUser }>('/auth/me')
  return 'user' in data ? data.user : data
}
