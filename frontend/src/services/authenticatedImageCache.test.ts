import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAuthenticatedAsset } from './assets'
import {
  clearAuthenticatedImageCache,
  getAuthenticatedImageBlob,
  prefetchAuthenticatedImage,
} from './authenticatedImageCache'

vi.mock('./assets', () => ({
  fetchAuthenticatedAsset: vi.fn(),
}))

describe('authenticated image cache', () => {
  beforeEach(() => {
    clearAuthenticatedImageCache()
    vi.mocked(fetchAuthenticatedAsset).mockReset()
  })

  it('shares one download between prefetch and display', async () => {
    const blob = new Blob(['preview'], { type: 'image/webp' })
    vi.mocked(fetchAuthenticatedAsset).mockResolvedValue(blob)

    const prefetched = prefetchAuthenticatedImage('/api/materials/image/2?variant=preview')
    const displayed = getAuthenticatedImageBlob('/api/materials/image/2?variant=preview')

    await expect(prefetched).resolves.toBe(blob)
    await expect(displayed).resolves.toBe(blob)
    expect(fetchAuthenticatedAsset).toHaveBeenCalledTimes(1)
  })

  it('forgets failed downloads so retry can succeed', async () => {
    vi.mocked(fetchAuthenticatedAsset)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Blob(['ok'], { type: 'image/webp' }))

    await expect(getAuthenticatedImageBlob('/api/materials/image/3?variant=preview'))
      .rejects.toThrow('offline')
    await expect(getAuthenticatedImageBlob('/api/materials/image/3?variant=preview'))
      .resolves.toBeInstanceOf(Blob)
    expect(fetchAuthenticatedAsset).toHaveBeenCalledTimes(2)
  })
})
