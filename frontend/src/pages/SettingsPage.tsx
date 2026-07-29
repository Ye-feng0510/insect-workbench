import { useState, useEffect } from 'react'
import { Save, Plug, RotateCcw, Loader2 } from 'lucide-react'
import { useToast } from '@/components/Toast'
import Loading from '@/components/Loading'
import TemplateSettings from '@/components/TemplateSettings'
import {
  getModelConfig,
  updateModelConfig,
  getPrompts,
  updatePrompts,
  testModel,
} from '@/services/settings'
import type { ModelConfig, PromptConfig, TestModelResponse } from '@/types'
import { extractErrorMessage } from '@/types'

export default function SettingsPage() {
  const { show } = useToast()
  const [model, setModel] = useState<ModelConfig>({ base_url: '', api_key: '', model_name: '' })
  const [prompts, setPrompts] = useState<PromptConfig>({ recognition_prompt: '', taxonomy_prompt: '' })
  const [loading, setLoading] = useState(true)
  const [savingModel, setSavingModel] = useState(false)
  const [savingPrompts, setSavingPrompts] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestModelResponse | null>(null)

  useEffect(() => {
    Promise.all([getModelConfig(), getPrompts()])
      .then(([m, p]) => {
        setModel(m)
        setPrompts(p)
      })
      .catch((e) => show(extractErrorMessage(e, '加载配置失败'), 'error'))
      .finally(() => setLoading(false))
  }, [show])

  const handleSaveModel = async () => {
    setSavingModel(true)
    try {
      const saved = await updateModelConfig(model)
      setModel(saved)
      show('模型配置已保存', 'success')
    } catch (e) {
      show(extractErrorMessage(e, '保存失败'), 'error')
    } finally {
      setSavingModel(false)
    }
  }

  const handleSavePrompts = async () => {
    setSavingPrompts(true)
    try {
      await updatePrompts(prompts)
      show('提示词已保存', 'success')
    } catch (e) {
      show(extractErrorMessage(e, '保存失败'), 'error')
    } finally {
      setSavingPrompts(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      // 先保存再测试
      const saved = await updateModelConfig(model)
      setModel(saved)
      const result = await testModel({
        base_url: saved.base_url,
        api_key: saved.api_key,
        model_name: saved.model_name,
      })
      setTestResult(result)
      if (result.overall) {
        show('模型测试通过: 图片输入和文本分类均可用', 'success')
      } else {
        show('模型测试未完全通过,请查看详细结果', 'error')
      }
    } catch (e) {
      show(extractErrorMessage(e, '测试连接失败'), 'error')
    } finally {
      setTesting(false)
    }
  }

  const handleResetPrompts = async () => {
    if (!confirm('确定恢复默认提示词?当前编辑的内容将丢失。')) return
    setPrompts({ recognition_prompt: '', taxonomy_prompt: '' })
    // 保存空值让后端使用默认值
    try {
      await updatePrompts({ recognition_prompt: '', taxonomy_prompt: '' })
      const defaults = await getPrompts()
      setPrompts(defaults)
      show('已恢复默认提示词', 'success')
    } catch (e) {
      show(extractErrorMessage(e, '恢复失败'), 'error')
    }
  }

  if (loading) {
    return <Loading />
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold text-gray-800">设置</h1>

      {/* A. 模型 API 设置 */}
      <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="mb-1 text-lg font-semibold text-gray-700">A. 模型 API 设置</h2>
        <p className="mb-4 text-sm text-gray-400">
          只需填写 Base URL、API Key 和模型名称。Base URL 必须是 API 根地址(如 https://example.com/v1)。
        </p>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-600">Base URL</label>
            <input
              type="text"
              value={model.base_url}
              onChange={(e) => setModel({ ...model, base_url: e.target.value })}
              placeholder="https://api.example.com/v1"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-600">API Key</label>
            <input
              type="password"
              value={model.api_key}
              onChange={(e) => setModel({ ...model, api_key: e.target.value })}
              placeholder="sk-..."
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-600">模型名称</label>
            <input
              type="text"
              value={model.model_name}
              onChange={(e) => setModel({ ...model, model_name: e.target.value })}
              placeholder="如 glm-4v-plus / qwen-vl-plus"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </div>

          {testResult && (
            <div className="space-y-2 rounded-lg border border-gray-200 p-3">
              <div className={`flex items-start gap-2 text-sm ${testResult.image_test.passed ? 'text-emerald-700' : 'text-red-700'}`}>
                <span className="font-medium">
                  {testResult.image_test.passed ? '✓' : '✗'} 图片输入测试:
                </span>
                <span>{testResult.image_test.message}</span>
              </div>
              <div className={`flex items-start gap-2 text-sm ${testResult.text_json_test.passed ? 'text-emerald-700' : 'text-red-700'}`}>
                <span className="font-medium">
                  {testResult.text_json_test.passed ? '✓' : '✗'} 文本JSON分类测试:
                </span>
                <span>{testResult.text_json_test.message}</span>
              </div>
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={handleSaveModel}
              disabled={savingModel}
              className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
            >
              {savingModel ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              保存配置
            </button>
            <button
              onClick={handleTest}
              disabled={testing || !model.base_url || !model.model_name}
              className="flex items-center gap-2 rounded-lg border border-emerald-600 px-4 py-2 text-sm font-medium text-emerald-600 transition-colors hover:bg-emerald-50 disabled:opacity-50"
            >
              {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
              测试连接
            </button>
          </div>
        </div>
      </section>

      {/* B. 提示词设置 */}
      <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-700">B. 提示词设置</h2>
            <p className="text-sm text-gray-400">编辑 AI 识别和分类的提示词。</p>
          </div>
          <button
            onClick={handleResetPrompts}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-gray-500 transition-colors hover:bg-gray-100"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            恢复默认
          </button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-600">视觉识别系统提示词</label>
            <textarea
              value={prompts.recognition_prompt}
              onChange={(e) => setPrompts({ ...prompts, recognition_prompt: e.target.value })}
              rows={12}
              className="w-full resize-y rounded-lg border border-gray-300 px-3 py-2 font-mono text-xs focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-600">分类补全提示词</label>
            <textarea
              value={prompts.taxonomy_prompt}
              onChange={(e) => setPrompts({ ...prompts, taxonomy_prompt: e.target.value })}
              rows={12}
              className="w-full resize-y rounded-lg border border-gray-300 px-3 py-2 font-mono text-xs focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </div>
          <button
            onClick={handleSavePrompts}
            disabled={savingPrompts}
            className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
          >
            {savingPrompts ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            保存提示词
          </button>
        </div>
      </section>

      {/* C. Excel 模板设置 */}
      <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="mb-1 text-lg font-semibold text-gray-700">C. Excel 模板设置</h2>
        <p className="mb-4 text-sm text-gray-400">
          上传 Excel 模板,配置字段映射。系统只写入 13 个目标字段,保留模板原有数据。
        </p>
        <TemplateSettings />
      </section>
    </div>
  )
}
