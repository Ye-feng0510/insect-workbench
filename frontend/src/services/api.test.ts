import { AxiosError, AxiosHeaders } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import api, { configureOwnerHeader, setCsrfToken } from './api'

describe('API authentication interceptors', () => {
  beforeEach(() => {
    sessionStorage.clear()
    configureOwnerHeader(false, null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('adds credentials, CSRF, and explicit owner only for an administrator', async () => {
    setCsrfToken('csrf-value')
    configureOwnerHeader(true, 42)
    let capturedHeaders = new AxiosHeaders()

    await api.post('/records/1/reclassify', null, {
      adapter: async (config) => {
        capturedHeaders = AxiosHeaders.from(config.headers)
        return {
          data: {},
          status: 200,
          statusText: 'OK',
          headers: {},
          config,
        }
      },
    })

    expect(api.defaults.withCredentials).toBe(true)
    expect(capturedHeaders.get('X-CSRF-Token')).toBe('csrf-value')
    expect(capturedHeaders.get('X-Owner-ID')).toBe('42')

    configureOwnerHeader(false, 99)
    await api.get('/records', {
      adapter: async (config) => {
        capturedHeaders = AxiosHeaders.from(config.headers)
        return {
          data: [],
          status: 200,
          statusText: 'OK',
          headers: {},
          config,
        }
      },
    })
    expect(capturedHeaders.has('X-Owner-ID')).toBe(false)
  })

  it('does not attach owner context to admin endpoints', async () => {
    configureOwnerHeader(true, 42)
    let capturedHeaders = new AxiosHeaders()
    await api.get('/admin/users', {
      adapter: async (config) => {
        capturedHeaders = AxiosHeaders.from(config.headers)
        return {
          data: [],
          status: 200,
          statusText: 'OK',
          headers: {},
          config,
        }
      },
    })
    expect(capturedHeaders.has('X-Owner-ID')).toBe(false)
  })

  it.each([
    [401, 'auth:unauthorized'],
    [403, 'auth:forbidden'],
  ])('emits the authoritative auth event for HTTP %s', async (status, eventName) => {
    const listener = vi.fn()
    window.addEventListener(eventName, listener)
    await expect(api.get('/records', {
      adapter: async (config) => Promise.reject(new AxiosError(
        'request failed',
        undefined,
        config,
        undefined,
        {
          data: { detail: 'denied' },
          status,
          statusText: 'Denied',
          headers: {},
          config,
        },
      )),
    })).rejects.toBeInstanceOf(AxiosError)
    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener(eventName, listener)
  })
})
