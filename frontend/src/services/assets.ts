import api from './api'

const ALLOWED_ASSET_PATHS = [
  '/api/recognition/image/',
  '/api/materials/image/',
  '/api/export/download/',
]
const ALLOWED_EXACT_ASSET_PATHS = ['/api/materials/skipped/export']

function apiRelativeUrl(url: string): string {
  const origin = window.location.origin
  const parsed = new URL(url, origin)
  if (
    parsed.origin !== origin
    || (
      !ALLOWED_ASSET_PATHS.some((prefix) => parsed.pathname.startsWith(prefix))
      && !ALLOWED_EXACT_ASSET_PATHS.includes(parsed.pathname)
    )
  ) {
    throw new Error('不允许访问非本站或未授权的资源地址')
  }
  return `${parsed.pathname.slice(4)}${parsed.search}`
}

export async function fetchAuthenticatedAsset(url: string): Promise<Blob> {
  const { data } = await api.get<Blob>(apiRelativeUrl(url), { responseType: 'blob' })
  return data
}

export async function downloadAuthenticatedAsset(url: string, filename?: string): Promise<void> {
  const blob = await fetchAuthenticatedAsset(url)
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = filename ?? url.split('/').pop() ?? 'download'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
}
