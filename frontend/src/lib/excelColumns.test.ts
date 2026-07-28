import { describe, it, expect } from 'vitest'
import {
  columnIndexToLetter,
  columnLetterToIndex,
  TARGET_FIELDS,
} from './excelColumns'

describe('columnIndexToLetter', () => {
  it('单字母列', () => {
    expect(columnIndexToLetter(0)).toBe('A')
    expect(columnIndexToLetter(25)).toBe('Z')
  })

  it('双字母列', () => {
    expect(columnIndexToLetter(26)).toBe('AA')
    expect(columnIndexToLetter(30)).toBe('AE') // 清单示例中的图像列
  })

  it('抛出非法输入', () => {
    expect(() => columnIndexToLetter(-1)).toThrow()
    expect(() => columnIndexToLetter(1.5)).toThrow()
  })
})

describe('columnLetterToIndex', () => {
  it('单字母列', () => {
    expect(columnLetterToIndex('A')).toBe(0)
    expect(columnLetterToIndex('Z')).toBe(25)
  })

  it('双字母列(不区分大小写)', () => {
    expect(columnLetterToIndex('AE')).toBe(30)
    expect(columnLetterToIndex('ae')).toBe(30)
    expect(columnLetterToIndex('AI')).toBe(34) // 清单示例中的采集人列
  })

  it('互转一致性', () => {
    for (let i = 0; i < 100; i++) {
      expect(columnLetterToIndex(columnIndexToLetter(i))).toBe(i)
    }
  })

  it('抛出非法输入', () => {
    expect(() => columnLetterToIndex('')).toThrow()
    expect(() => columnLetterToIndex('1A')).toThrow()
  })
})

describe('TARGET_FIELDS', () => {
  it('正好 13 个字段', () => {
    expect(TARGET_FIELDS).toHaveLength(13)
  })
})
