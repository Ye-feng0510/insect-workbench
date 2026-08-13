import api from './api'

export const EXPECTED_BACKEND_VERSION = 'v1.3.3'
export const REQUIRED_BACKEND_CAPABILITY = 'agent_workflows_v1'

interface HealthResponse {
  version?: unknown
  capabilities?: unknown
}

export type BackendCompatibility =
  | {
    compatible: true
    version: string
    capabilities: string[]
  }
  | {
    compatible: false
    reason: 'unreachable' | 'missing_metadata' | 'version_mismatch' | 'missing_capability'
    version: string | null
    capabilities: string[]
  }

export async function checkBackendCompatibility(): Promise<BackendCompatibility> {
  try {
    const response = await api.get<HealthResponse>('/health')
    const version = typeof response.data?.version === 'string'
      ? response.data.version
      : null
    const capabilities = Array.isArray(response.data?.capabilities)
      ? response.data.capabilities.filter(
        (capability): capability is string => typeof capability === 'string',
      )
      : []

    if (version === null || !Array.isArray(response.data?.capabilities)) {
      return {
        compatible: false,
        reason: 'missing_metadata',
        version,
        capabilities,
      }
    }
    if (version !== EXPECTED_BACKEND_VERSION) {
      return {
        compatible: false,
        reason: 'version_mismatch',
        version,
        capabilities,
      }
    }
    if (!capabilities.includes(REQUIRED_BACKEND_CAPABILITY)) {
      return {
        compatible: false,
        reason: 'missing_capability',
        version,
        capabilities,
      }
    }
    return { compatible: true, version, capabilities }
  } catch {
    return {
      compatible: false,
      reason: 'unreachable',
      version: null,
      capabilities: [],
    }
  }
}
