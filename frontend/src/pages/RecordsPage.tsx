import { useState, useEffect } from 'react'
import {
  Search, Filter, Edit2, Trash2, RefreshCw, Eye, Loader2,
  X, Save, AlertCircle,
} from 'lucide-react'
import { useToast } from '@/components/Toast'
import {
  listRecords, updateRecord, deleteRecord, reclassifyRecord,
} from '@/services/records'
import { imageUrl } from '@/services/draft'
import { extractErrorMessage } from '@/types'
import type { RecordDetail } from '@/types'
import { STATUS_LABELS, STATUS_COLORS, IMAGE_FIELDS, TAXONOMY_FIELDS } from '@/lib/status'

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'awaiting_confirmation', label: '待确认' },
  { value: 'completed', label: '已完成' },
  { value: 'classification_failed', label: '分类失败' },
  { value: 'extraction_failed', label: '识别失败' },
]

export default function RecordsPage() {
  const { show } = useToast()
  const [records, setRecords] = useState<RecordDetail[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [editing, setEditing] = useState<RecordDetail | null>(null)
  const [editFields, setEditFields] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [viewingImage, setViewingImage] = useState<RecordDetail | null>(null)
  const [deleting, setDeleting] = useState<RecordDetail | null>(null)
  const [reclassifying, setReclassifying] = useState<number | null>(null)

  useEffect(() => {
    loadRecords()
  }, [])

  const loadRecords = async () => {
    setLoading(true)
    try {
      const data = await listRecords(search || undefined, statusFilter || undefined)
      setRecords(data)
    } catch (e) {
      show(extractErrorMessage(e, '加载记录失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  const handleSearch = () => {
    loadRecords()
  }

  const handleEdit = (record: RecordDetail) => {
    setEditing(record)
    setEditFields({ ...record.fields })
  }

  const handleSaveEdit = async () => {
    if (!editing) return
    setSaving(true)
    try {
      await updateRecord(editing.id, editFields)
      show('记录已更新', 'success')
      setEditing(null)
      loadRecords()
    } catch (e) {
      show(extractErrorMessage(e, '更新失败'), 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleting) return
    try {
      await deleteRecord(deleting.id)
      show('记录已删除', 'success')
      setDeleting(null)
      loadRecords()
    } catch (e) {
      show(extractErrorMessage(e, '删除失败'), 'error')
    }
  }

  const handleReclassify = async (record: RecordDetail) => {
    setReclassifying(record.id)
    try {
      const result = await reclassifyRecord(record.id)
      if (result.status === 'completed') {
        show(`重新分类成功,已更新 Excel 第 ${result.excel_row} 行`, 'success')
      } else {
        show('分类仍然失败,请检查中名或手动编辑分类字段', 'error')
      }
      loadRecords()
    } catch (e) {
      show(extractErrorMessage(e, '重新分类失败'), 'error')
    } finally {
      setReclassifying(null)
    }
  }

  const updateEditField = (field: string, value: string) => {
    setEditFields(prev => ({ ...prev, [field]: value }))
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-gray-800">记录管理</h1>

      {/* 搜索栏 */}
      <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-3">
        <div className="flex flex-1 items-center gap-2">
          <Search className="h-4 w-4 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="按中名或图像编号搜索..."
            className="flex-1 text-sm focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-gray-400" />
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setTimeout(loadRecords, 0) }}
            className="rounded-md border border-gray-300 px-2 py-1 text-sm focus:outline-none"
          >
            {STATUS_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <button
          onClick={handleSearch}
          className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
        >
          搜索
        </button>
      </div>

      {/* 记录列表 */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-emerald-600" />
        </div>
      ) : records.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white py-12 text-center text-gray-400">
          暂无记录
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs text-gray-500">
                <th className="px-3 py-2">图像编号</th>
                <th className="px-3 py-2">中名</th>
                <th className="px-3 py-2">产地3</th>
                <th className="px-3 py-2">采集人</th>
                <th className="px-3 py-2">采集日期</th>
                <th className="px-3 py-2">状态</th>
                <th className="px-3 py-2">创建时间</th>
                <th className="px-3 py-2 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {records.map(r => (
                <tr key={r.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="px-3 py-2 font-medium text-gray-700">{r.fields['图像'] || '-'}</td>
                  <td className="px-3 py-2">{r.fields['中名'] || '-'}</td>
                  <td className="px-3 py-2 text-gray-500">{r.fields['产地3'] || '-'}</td>
                  <td className="px-3 py-2 text-gray-500">{r.fields['采集人'] || '-'}</td>
                  <td className="px-3 py-2 text-gray-500">{r.fields['采集日期'] || '-'}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_COLORS[r.status] ?? 'bg-gray-100'}`}>
                      {STATUS_LABELS[r.status] ?? r.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-400">
                    {r.created_at ? new Date(r.created_at).toLocaleString('zh-CN', { hour12: false }) : '-'}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => setViewingImage(r)}
                        className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-emerald-600"
                        title="查看原图"
                      >
                        <Eye className="h-4 w-4" />
                      </button>
                      {(r.status === 'classification_failed' || r.status === 'completed') && (
                        <button
                          onClick={() => handleReclassify(r)}
                          disabled={reclassifying === r.id}
                          className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-purple-600 disabled:opacity-50"
                          title="重新分类"
                        >
                          {reclassifying === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                        </button>
                      )}
                      <button
                        onClick={() => handleEdit(r)}
                        className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-blue-600"
                        title="编辑"
                      >
                        <Edit2 className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => setDeleting(r)}
                        className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-600"
                        title="删除"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 编辑弹窗 */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="max-h-[80vh] w-[600px] overflow-y-auto rounded-xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-800">
                编辑记录 #{editing.id}
              </h3>
              <button onClick={() => setEditing(null)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <h4 className="mb-2 text-sm font-medium text-gray-600">图片原始信息</h4>
                <div className="grid grid-cols-2 gap-3">
                  {IMAGE_FIELDS.map(field => (
                    <div key={field}>
                      <label className="mb-1 block text-xs text-gray-500">{field}</label>
                      <input
                        type={field === '采集日期' ? 'date' : 'text'}
                        value={editFields[field] ?? ''}
                        onChange={(e) => updateEditField(field, e.target.value)}
                        className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-emerald-500 focus:outline-none"
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h4 className="mb-2 text-sm font-medium text-gray-600">分类信息</h4>
                <div className="grid grid-cols-2 gap-3">
                  {TAXONOMY_FIELDS.map(field => (
                    <div key={field}>
                      <label className="mb-1 block text-xs text-gray-500">{field}</label>
                      <input
                        type="text"
                        value={editFields[field] ?? ''}
                        onChange={(e) => updateEditField(field, e.target.value)}
                        className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-emerald-500 focus:outline-none"
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setEditing(null)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={saving}
                className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 查看原图弹窗 */}
      {viewingImage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setViewingImage(null)}>
          <div className="max-h-[90vh] max-w-[90vw] overflow-auto">
            <img
              src={viewingImage.image_path ? imageUrl(viewingImage.image_path) : ''}
              alt={`记录 ${viewingImage.id}`}
              className="max-h-[90vh] max-w-[90vw] object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          <button
            onClick={() => setViewingImage(null)}
            className="absolute right-4 top-4 rounded-full bg-white/80 p-2 text-gray-600 hover:bg-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      )}

      {/* 删除确认弹窗 */}
      {deleting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-96 rounded-xl bg-white p-6 shadow-xl">
            <div className="mb-3 flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-red-500" />
              <h3 className="text-lg font-semibold text-gray-800">确认删除</h3>
            </div>
            <p className="mb-4 text-sm text-gray-500">
              确定删除记录 #{deleting.id}({deleting.fields['中名'] || '未命名'})?
              该操作不可恢复,关联的图片文件也会被删除。
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeleting(null)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={handleDelete}
                className="rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
