import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import AiWhale from './AiWhale'

describe('AiWhale', () => {
  it('exposes the current assistant state accessibly', () => {
    render(<AiWhale state="recognizing" />)

    expect(screen.getByRole('img', { name: 'AI 正在读取标本' })).toBeInTheDocument()
    expect(screen.getByText('AI 正在读取标本')).toBeInTheDocument()
  })

  it('keeps compact mode free of duplicate visible labels', () => {
    render(<AiWhale state="idle" compact />)

    expect(screen.getByRole('img', { name: 'AI 鲸鱼待命中' })).toBeInTheDocument()
    expect(screen.queryByText('AI 鲸鱼待命中')).not.toBeInTheDocument()
  })
})
