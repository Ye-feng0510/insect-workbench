import { afterEach, describe, expect, it, vi } from 'vitest'
import api from './api'
import {
  checkBackendCompatibility,
  EXPECTED_BACKEND_VERSION,
  isConnectivityIssue,
  REQUIRED_BACKEND_CAPABILITY,
} from './version'

describe('backend compatibility handshake', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('treats only unreachable as a connectivity issue', () => {
    expect(isConnectivityIssue('unreachable')).toBe(true)
    expect(isConnectivityIssue('missing_metadata')).toBe(false)
    expect(isConnectivityIssue('version_mismatch')).toBe(false)
    expect(isConnectivityIssue('missing_capability')).toBe(false)
  })

  it('accepts the exact backend version with the required capability', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        status: 'ok',
        app: 'workbench',
        version: EXPECTED_BACKEND_VERSION,
        capabilities: [REQUIRED_BACKEND_CAPABILITY, 'another_capability'],
      },
    })

    await expect(checkBackendCompatibility()).resolves.toEqual({
      compatible: true,
      version: EXPECTED_BACKEND_VERSION,
      capabilities: [REQUIRED_BACKEND_CAPABILITY, 'another_capability'],
    })
    expect(api.get).toHaveBeenCalledWith('/health')
  })

  it('rejects an old health response without version metadata or capabilities', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { status: 'ok', app: 'workbench' },
    })

    await expect(checkBackendCompatibility()).resolves.toEqual({
      compatible: false,
      reason: 'missing_metadata',
      version: null,
      capabilities: [],
    })
  })

  it('rejects a backend with a mismatched version', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        status: 'ok',
        app: 'workbench',
        version: '1.1.0',
        capabilities: [REQUIRED_BACKEND_CAPABILITY],
      },
    })

    await expect(checkBackendCompatibility()).resolves.toEqual({
      compatible: false,
      reason: 'version_mismatch',
      version: '1.1.0',
      capabilities: [REQUIRED_BACKEND_CAPABILITY],
    })
  })

  it('rejects the expected version when the workflow capability is absent', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        status: 'ok',
        app: 'workbench',
        version: EXPECTED_BACKEND_VERSION,
        capabilities: [],
      },
    })

    await expect(checkBackendCompatibility()).resolves.toEqual({
      compatible: false,
      reason: 'missing_capability',
      version: EXPECTED_BACKEND_VERSION,
      capabilities: [],
    })
  })
})
