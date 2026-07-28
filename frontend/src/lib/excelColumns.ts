/**
 * Excel 列字母与列序号(0-based)互转工具。
 * 例: 0 <-> "A", 25 <-> "Z", 26 <-> "AA", 30 <-> "AE"。
 */

/** 列序号(0-based)转 Excel 列字母,如 0 -> "A"。 */
export function columnIndexToLetter(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`列序号必须是非负整数,收到 ${index}`)
  }
  let n = index
  let letters = ''
  while (true) {
    const rem = n % 26
    letters = String.fromCharCode(65 + rem) + letters
    n = Math.floor(n / 26) - 1
    if (n < 0) break
  }
  return letters
}

/** Excel 列字母转列序号(0-based),如 "AE" -> 30。 */
export function columnLetterToIndex(letter: string): number {
  const normalized = letter.trim().toUpperCase()
  if (!/^[A-Z]+$/.test(normalized)) {
    throw new Error(`列字母格式无效: ${letter}`)
  }
  let index = 0
  for (let i = 0; i < normalized.length; i++) {
    index = index * 26 + (normalized.charCodeAt(i) - 64)
  }
  return index - 1
}

/** 13 个目标字段(顺序与清单第4节一致)。 */
export const TARGET_FIELDS = [
  '中名',
  'Phylum',
  '纲',
  'Class',
  'Order',
  '中文科名',
  '科名',
  '属名',
  '种名',
  '产地3',
  '图像',
  '采集人',
  '采集日期',
] as const

export type TargetField = (typeof TARGET_FIELDS)[number]

/** 从图片直接识别的 5 个字段。 */
export const IMAGE_EXTRACTED_FIELDS = [
  '中名',
  '产地3',
  '图像',
  '采集人',
  '采集日期',
] as const

/** 根据中名补全的 8 个分类字段。 */
export const TAXONOMY_FIELDS = [
  'Phylum',
  '纲',
  'Class',
  'Order',
  '中文科名',
  '科名',
  '属名',
  '种名',
] as const
