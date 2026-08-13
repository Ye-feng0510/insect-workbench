import { fetchAuthenticatedAsset } from './assets'

const MAX_ENTRIES = 4

interface Entry {
  promise: Promise<Blob>
  lastUsed: number
}

const entries = new Map<string, Entry>()

function evict() {
  while (entries.size > MAX_ENTRIES) {
    const oldest = [...entries.entries()]
      .sort(([, left], [, right]) => left.lastUsed - right.lastUsed)[0]
    if (!oldest) return
    entries.delete(oldest[0])
  }
}

export function getAuthenticatedImageBlob(url: string): Promise<Blob> {
  const existing = entries.get(url)
  if (existing) {
    existing.lastUsed = Date.now()
    return existing.promise
  }

  const promise = fetchAuthenticatedAsset(url).catch((error) => {
    entries.delete(url)
    throw error
  })
  entries.set(url, { promise, lastUsed: Date.now() })
  evict()
  return promise
}

export function prefetchAuthenticatedImage(url: string): Promise<Blob> {
  return getAuthenticatedImageBlob(url)
}

export function clearAuthenticatedImageCache(): void {
  entries.clear()
}
