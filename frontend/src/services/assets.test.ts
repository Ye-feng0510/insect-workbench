import { beforeEach, describe, expect, it, vi } from 'vitest'
import api from './api'
import { fetchAuthenticatedAsset } from './assets'

vi.mock('./api', () => ({
  default: {
    get: vi.fn(),
  },
}))

describe('authenticated asset allowlist', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset()
    vi.mocked(api.get).mockResolvedValue({ data: new Blob(['ok']) })
  })

  it('fetches approved same-origin API assets through the authenticated client', async () => {
    await fetchAuthenticatedAsset('/api/recognition/image/specimen.jpg')
    expect(api.get).toHaveBeenCalledWith(
      '/recognition/image/specimen.jpg',
      { responseType: 'blob' },
    )
  })

  it('fetches stable record image URLs through the authenticated client', async () => {
    await fetchAuthenticatedAsset('/api/recognition/501/image')
    expect(api.get).toHaveBeenCalledWith(
      '/recognition/501/image',
      { responseType: 'blob' },
    )
  })

  it.each([
    'https://example.com/api/recognition/image/specimen.jpg',
    '/api/records',
    '/api/recognition/not-a-record/image',
    '/api/materials/skipped/export-other',
  ])('rejects unapproved asset URL %s', async (url) => {
    await expect(fetchAuthenticatedAsset(url)).rejects.toThrow(
      '不允许访问非本站或未授权的资源地址',
    )
    expect(api.get).not.toHaveBeenCalled()
  })
})
