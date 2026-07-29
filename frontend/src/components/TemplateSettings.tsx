import { useState, useEffect, useRef } from 'react'
import { Upload, FileSpreadsheet, Loader2, Save, FlaskConical, CheckCircle, AlertCircle } from 'lucide-react'
import { useToast } from '@/components/Toast'
import {
  uploadTemplate,
  getCurrentTemplate,
  getSheets,
  inspectTemplate,
  updateMapping,
  testTemplate,
  type InspectResult,
  type TestMappingResult,
} from '@/services/templates'
import type { TemplateInfo, SheetInfo, FieldMappingUpdate } from '@/types'
import { extractErrorMessage } from '@/types'
import { TARGET_FIELDS } from '@/lib/excelColumns'

const ALL_LETTERS = Array.from({ length: 52 }, (_, i) => {
  let n = i
  let s = ''
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
})

export default function TemplateSettings() {
  const { show } = useToast()
  const [template, setTemplate] = useState<TemplateInfo | null>(null)
  const [sheets, setSheets] = useState<SheetInfo[]>([])
  const [selectedSheet, setSelectedSheet] = useState('')
  const [headerRow, setHeaderRow] = useState(1)
  const [startRow, setStartRow] = useState(2)
  const [styleSourceRow, setStyleSourceRow] = useState(2)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [inspectResult, setInspectResult] = useState<InspectResult | null>(null)
  const [testResult, setTestResult] = useState<TestMappingResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [inspecting, setInspecting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    loadTemplate()
  }, [])

  const loadTemplate = async () => {
    setLoading(true)
    try {
      const t = await getCurrentTemplate()
      setTemplate(t)
      if (t) {
        setSelectedSheet(t.target_sheet)
        setHeaderRow(t.header_row)
        setStartRow(t.start_row)
        setStyleSourceRow(t.style_source_row)
        setMapping(t.field_mapping)
        const s = await getSheets(t.id)
        setSheets(s)
      }
    } catch (e) {
      show(extractErrorMessage(e, '加载模板失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  const handleUpload = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      show('只支持 .xlsx 格式', 'error')
      return
    }
    setUploading(true)
    try {
      const t = await uploadTemplate(file)
      setTemplate(t)
      show(`已上传模板: ${t.original_filename}`, 'success')
      const s = await getSheets(t.id)
      setSheets(s)
      // 自动 inspect 第一个工作表
      const result = await inspectTemplate(t.id, s[0]?.name)
      setInspectResult(result)
      setSelectedSheet(result.sheet_name)
      setHeaderRow(result.detected_header_row)
      setMapping(result.field_mapping)
    } catch (e) {
      show(extractErrorMessage(e, '上传失败'), 'error')
    } finally {
      setUploading(false)
    }
  }

  const handleInspect = async () => {
    if (!template) return
    setInspecting(true)
    setInspectResult(null)
    try {
      const result = await inspectTemplate(template.id, selectedSheet, headerRow)
      setInspectResult(result)
      setMapping(result.field_mapping)
      if (result.unmatched.length === 0) {
        show(`自动匹配全部 ${Object.keys(result.field_mapping).length} 个字段`, 'success')
      } else {
        show(`匹配 ${Object.keys(result.field_mapping).length} 个字段, ${result.unmatched.length} 个需手动映射`, 'info')
      }
    } catch (e) {
      show(extractErrorMessage(e, '检测失败'), 'error')
    } finally {
      setInspecting(false)
    }
  }

  const handleSave = async () => {
    if (!template) return
    setSaving(true)
    try {
      const config: FieldMappingUpdate = {
        target_sheet: selectedSheet,
        header_row: headerRow,
        start_row: startRow,
        style_source_row: styleSourceRow,
        field_mapping: mapping,
      }
      const t = await updateMapping(template.id, config)
      setTemplate(t)
      show(`配置已保存,数据将从第 ${t.base_write_row} 行开始写入`, 'success')
    } catch (e) {
      show(extractErrorMessage(e, '保存失败'), 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    if (!template) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await testTemplate(template.id)
      setTestResult(result)
      show('模板测试通过', 'success')
    } catch (e) {
      show(extractErrorMessage(e, '测试失败'), 'error')
    } finally {
      setTesting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-emerald-600" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* 上传区 */}
      <div
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          const f = e.dataTransfer.files[0]
          if (f) handleUpload(f)
        }}
        className="flex cursor-pointer items-center gap-3 rounded-lg border-2 border-dashed border-gray-300 p-4 transition-colors hover:border-emerald-400 hover:bg-emerald-50/50"
      >
        {uploading ? (
          <Loader2 className="h-8 w-8 animate-spin text-emerald-600" />
        ) : (
          <Upload className="h-8 w-8 text-emerald-600" />
        )}
        <div>
          <p className="text-sm font-medium text-gray-700">
            {uploading ? '上传中...' : '点击或拖拽上传 Excel 模板 (.xlsx)'}
          </p>
          {template && (
            <p className="text-xs text-gray-400">当前: {template.original_filename}</p>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) handleUpload(f)
            e.target.value = ''
          }}
        />
      </div>

      {template && sheets.length > 0 && (
        <>
          {/* 工作表和行配置 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">目标工作表</label>
              <select
                value={selectedSheet}
                onChange={(e) => setSelectedSheet(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
              >
                {sheets.map((s) => (
                  <option key={s.name} value={s.name}>{s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">表头行</label>
              <input
                type="number"
                min={1}
                value={headerRow}
                onChange={(e) => setHeaderRow(Number(e.target.value))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">开始写入行</label>
              <input
                type="number"
                min={1}
                value={startRow}
                onChange={(e) => setStartRow(Number(e.target.value))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">格式来源行</label>
              <input
                type="number"
                min={1}
                value={styleSourceRow}
                onChange={(e) => setStyleSourceRow(Number(e.target.value))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
              />
            </div>
          </div>

          <button
            onClick={handleInspect}
            disabled={inspecting}
            className="flex items-center gap-2 rounded-lg border border-emerald-600 px-4 py-2 text-sm font-medium text-emerald-600 hover:bg-emerald-50 disabled:opacity-50"
          >
            {inspecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
            自动检测表头和字段
          </button>

          {/* 字段映射表 */}
          <div className="rounded-lg border border-gray-200">
            <div className="border-b border-gray-200 bg-gray-50 px-3 py-2">
              <span className="text-xs font-medium text-gray-600">字段列映射 ({Object.keys(mapping).length}/13)</span>
            </div>
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-sm">
                <tbody>
                  {TARGET_FIELDS.map((field) => (
                    <tr key={field} className="border-b border-gray-100 last:border-0">
                      <td className="px-3 py-1.5 font-medium text-gray-700">{field}</td>
                      <td className="px-3 py-1.5">
                        <select
                          value={mapping[field] || ''}
                          onChange={(e) => {
                            const newMap = { ...mapping }
                            if (e.target.value) {
                              newMap[field] = e.target.value
                            } else {
                              delete newMap[field]
                            }
                            setMapping(newMap)
                          }}
                          className={`rounded border px-2 py-1 text-xs ${
                            mapping[field]
                              ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                              : 'border-gray-300 text-gray-400'
                          }`}
                        >
                          <option value="">未映射</option>
                          {ALL_LETTERS.map((letter) => (
                            <option key={letter} value={letter}>{letter}</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 操作按钮 */}
          <div className="flex gap-3">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              保存配置
            </button>
            <button
              onClick={handleTest}
              disabled={testing}
              className="flex items-center gap-2 rounded-lg border border-emerald-600 px-4 py-2 text-sm font-medium text-emerald-600 hover:bg-emerald-50 disabled:opacity-50"
            >
              {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
              测试配置
            </button>
          </div>

          {/* base_write_row 显示 */}
          {template.base_write_row > 0 && template.target_sheet === selectedSheet && (
            <div className="flex items-center gap-2 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">
              <CheckCircle className="h-4 w-4" />
              数据将从第 <strong>{template.base_write_row}</strong> 行开始写入
            </div>
          )}

          {/* 测试结果 */}
          {testResult && (
            <div className="rounded-lg border border-gray-200 p-3 text-sm">
              <div className="mb-2 flex items-center gap-2 font-medium text-gray-700">
                {testResult.unmapped.length === 0 ? (
                  <><CheckCircle className="h-4 w-4 text-emerald-600" /> 映射完整</>
                ) : (
                  <><AlertCircle className="h-4 w-4 text-amber-500" /> {testResult.unmapped.length} 个字段未映射</>
                )}
              </div>
              <div className="space-y-1 text-xs text-gray-500">
                <p>工作表: {testResult.sheet_name}</p>
                <p>表头行: {testResult.header_row}</p>
                <p>开始写入行: {testResult.base_write_row}</p>
                <p>格式来源行: {testResult.style_source_row}</p>
                {testResult.sample_rows.length > 0 && (
                  <div className="mt-2">
                    <p className="font-medium">模板已有数据示例:</p>
                    {testResult.sample_rows.map((r) => (
                      <div key={r.excel_row} className="mt-1 rounded bg-gray-50 p-1.5">
                        <span className="text-gray-400">行 {r.excel_row}:</span>{' '}
                        {r.values['中名'] || '-'} / {r.values['图像'] || '-'}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
