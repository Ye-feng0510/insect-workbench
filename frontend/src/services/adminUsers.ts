import api from './api'
import type {
  AuthUser,
  CreateUserRequest,
  QuotaAdjustment,
  WorkflowUsage,
} from '@/types'

function unwrapList<T>(data: T[] | { items: T[] } | { users: T[] }): T[] {
  if (Array.isArray(data)) return data
  if ('items' in data) return data.items
  return data.users
}

export async function listUsers(): Promise<AuthUser[]> {
  const { data } = await api.get<AuthUser[] | { items: AuthUser[] } | { users: AuthUser[] }>(
    '/admin/users',
  )
  return unwrapList(data)
}

export async function createUser(request: CreateUserRequest): Promise<AuthUser> {
  const { data } = await api.post<AuthUser>('/admin/users', request)
  return data
}

export async function setUserActive(userId: number, isActive: boolean): Promise<AuthUser> {
  const { data } = await api.patch<AuthUser>(`/admin/users/${userId}`, {
    is_active: isActive,
  })
  return data
}

export async function resetUserPassword(userId: number, password: string): Promise<void> {
  await api.patch(`/admin/users/${userId}`, { password })
}

export async function setUserQuota(
  userId: number,
  quotaTotal: number,
  reason: string,
): Promise<AuthUser> {
  const { data } = await api.put<AuthUser>(`/admin/users/${userId}/quota`, {
    workflow_quota: quotaTotal,
    reason,
  })
  return data
}

export async function getQuotaHistory(userId: number): Promise<QuotaAdjustment[]> {
  const { data } = await api.get<QuotaAdjustment[]>('/admin/quota-adjustments')
  return data.filter((item) => item.user_id === userId)
}

export async function getUsageHistory(userId: number): Promise<WorkflowUsage[]> {
  const { data } = await api.get<WorkflowUsage[]>(
    `/admin/users/${userId}/usage-history`,
  )
  return data
}
