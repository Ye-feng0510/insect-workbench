import { describe, expect, it } from 'vitest'
import { extractErrorMessage } from './index'

describe('extractErrorMessage', () => {
  it('normalizes FastAPI validation details into renderable text', () => {
    const error = {
      response: {
        data: {
          detail: [
            { msg: 'Value error, 包含不支持的字段: 科名' },
            { msg: '图像编号不能为空' },
          ],
        },
      },
    }

    expect(extractErrorMessage(error)).toBe(
      'Value error, 包含不支持的字段: 科名；图像编号不能为空',
    )
  })

  it('uses a structured detail message when provided', () => {
    expect(extractErrorMessage({
      response: { data: { detail: { message: '图像编号已存在' } } },
    })).toBe('图像编号已存在')
  })
})
