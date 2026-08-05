import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  timeout: 130_000, // 略大于后端模型超时 120s
  withCredentials: true,
})

const CSRF_STORAGE_KEY = 'insect-csrf-token'
const UNSAFE_METHODS = new Set(['post', 'put', 'patch', 'delete'])

let currentUserIsAdmin = false
let selectedOwnerId: number | null = null
let ownerContextKey = 'user'
let ownerContextController = new AbortController()

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null
  const prefix = `${encodeURIComponent(name)}=`
  const value = document.cookie
    .split('; ')
    .find((cookie) => cookie.startsWith(prefix))
    ?.slice(prefix.length)
  return value ? decodeURIComponent(value) : null
}

export function setCsrfToken(token: string | null): void {
  if (typeof sessionStorage === 'undefined') return
  if (token) {
    sessionStorage.setItem(CSRF_STORAGE_KEY, token)
  } else {
    sessionStorage.removeItem(CSRF_STORAGE_KEY)
    if (typeof document !== 'undefined') {
      for (const name of ['csrf_token', 'insect_csrf', 'XSRF-TOKEN']) {
        document.cookie = `${encodeURIComponent(name)}=; Max-Age=0; Path=/; SameSite=Strict`
      }
    }
  }
}

function getCsrfToken(): string | null {
  return (
    readCookie('csrf_token')
    ?? readCookie('insect_csrf')
    ?? readCookie('XSRF-TOKEN')
    ?? (typeof sessionStorage === 'undefined'
      ? null
      : sessionStorage.getItem(CSRF_STORAGE_KEY))
  )
}

export function hasSessionHint(): boolean {
  return getCsrfToken() !== null
}

export function configureOwnerHeader(isAdmin: boolean, ownerId: number | null): void {
  const nextOwnerId = isAdmin ? ownerId : null
  const nextContextKey = isAdmin ? `admin:${nextOwnerId ?? ''}` : 'user'
  if (nextContextKey !== ownerContextKey) {
    ownerContextController.abort()
    ownerContextController = new AbortController()
    ownerContextKey = nextContextKey
  }
  currentUserIsAdmin = isAdmin
  selectedOwnerId = nextOwnerId
}

function isOwnerScopedRequest(url = ''): boolean {
  return !url.startsWith('/auth/')
    && !url.startsWith('/admin/')
    && !url.startsWith('/settings')
}

api.interceptors.request.use((config) => {
  const method = config.method?.toLowerCase() ?? 'get'
  const ownerScoped = isOwnerScopedRequest(config.url)
  const requestIsAdmin = currentUserIsAdmin
  const requestOwnerId = selectedOwnerId
  const requestOwnerSignal = ownerContextController.signal
  if (UNSAFE_METHODS.has(method) && config.url !== '/auth/login') {
    const csrfToken = getCsrfToken()
    if (csrfToken) {
      config.headers.set('X-CSRF-Token', csrfToken)
    }
  }
  if (
    requestIsAdmin
    && requestOwnerId !== null
    && ownerScoped
  ) {
    config.headers.set('X-Owner-ID', String(requestOwnerId))
  } else {
    config.headers.delete('X-Owner-ID')
  }
  if (ownerScoped && !config.signal) {
    config.signal = requestOwnerSignal
  }
  return config
})

const QUOTA_CHANGING_PATHS = [
  '/recognition/extract',
  '/re-extract',
  '/confirm-extraction',
  '/materials/next-extract',
]

api.interceptors.response.use(
  (response) => {
    const method = response.config.method?.toLowerCase() ?? 'get'
    const url = response.config.url ?? ''
    if (
      UNSAFE_METHODS.has(method)
      && (
        QUOTA_CHANGING_PATHS.some((path) => url.includes(path))
        || (url.includes('/workflows/') && url.endsWith('/commit'))
      )
      && typeof window !== 'undefined'
    ) {
      window.dispatchEvent(new Event('auth:quota-changed'))
    }
    return response
  },
  (error: unknown) => {
    const axiosError = axios.isAxiosError(error) ? error : null
    const status = axiosError?.response?.status
    const url = axiosError?.config?.url ?? ''
    if (
      status === 401
      && url !== '/auth/login'
      && typeof window !== 'undefined'
    ) {
      window.dispatchEvent(new Event('auth:unauthorized'))
    }
    if (status === 403 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('auth:forbidden', {
        detail: axiosError?.response?.data,
      }))
    }
    return Promise.reject(error)
  },
)

export default api
