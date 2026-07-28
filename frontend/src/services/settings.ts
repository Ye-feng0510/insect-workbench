import api from './api'
import type {
  ModelConfig,
  PromptConfig,
  TestModelRequest,
  TestModelResponse,
} from '@/types'

export async function getModelConfig(): Promise<ModelConfig> {
  const { data } = await api.get<ModelConfig>('/settings')
  return data
}

export async function updateModelConfig(config: ModelConfig): Promise<ModelConfig> {
  const { data } = await api.put<ModelConfig>('/settings', config)
  return data
}

export async function getPrompts(): Promise<PromptConfig> {
  const { data } = await api.get<PromptConfig>('/settings/prompts')
  return data
}

export async function updatePrompts(config: PromptConfig): Promise<PromptConfig> {
  const { data } = await api.put<PromptConfig>('/settings/prompts', config)
  return data
}

export async function testModel(req: TestModelRequest): Promise<TestModelResponse> {
  const { data } = await api.post<TestModelResponse>('/settings/test-model', req)
  return data
}
