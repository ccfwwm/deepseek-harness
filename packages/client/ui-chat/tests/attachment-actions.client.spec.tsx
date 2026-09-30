// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { UserStyleBubble } from '../src/client/chat/MessageItem.tsx'
import { zh } from '../src/client/locale.ts'

afterEach(cleanup)

const file = { type: 'file', attachment: { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'history.pdf', bytes: 152_000 } }
const t = makeTranslate(zh, commonZh)

describe('historical message file card', () => {
  it('drags an authenticated reference while keeping the card clickable for preview', () => {
    render(createElement(UserStyleBubble, { content: [file], renderMessageImages: () => null, fileActionScope: { sessionId: 'session-a' }, t }))
    const card = screen.getByTitle('history.pdf')
    expect(card.getAttribute('draggable')).toBe('true')
    const dataTransfer = { effectAllowed: 'none', setData: vi.fn() }
    fireEvent.dragStart(card, { dataTransfer })
    expect(dataTransfer.effectAllowed).toBe('copy')
    expect(dataTransfer.setData).toHaveBeenCalledWith('application/x-zerowall-history-attachment', JSON.stringify({
      sessionId: 'session-a', attachmentId: file.attachment.attachmentId,
    }))
  })

  it('opens the exact attachment in Sidebar and exposes copy and re-add actions', () => {
    type AttachmentActionDetail = {
      sessionId: string
      cwd?: string
      attachmentId: string
      complete: (success: boolean) => void
    }
    const seen: Array<{ type: string; detail: AttachmentActionDetail }> = []
    const receive = (event: Event): void => {
      event.preventDefault()
      const detail = (event as CustomEvent<AttachmentActionDetail>).detail
      seen.push({ type: event.type, detail })
      detail.complete(true)
    }
    for (const action of ['open', 'copy', 'readd']) window.addEventListener(`zerowall:attachment-${action}`, receive)
    try {
      render(createElement(UserStyleBubble, { content: [file], renderMessageImages: () => null, fileActionScope: { sessionId: 'session-a', cwd: 'C:/workspace' }, t }))
      fireEvent.click(screen.getByRole('button', { name: '预览文件 history.pdf' }))
      fireEvent.click(screen.getByRole('button', { name: '复制文件' }))
      fireEvent.click(screen.getByRole('button', { name: '重新添加到对话' }))
      expect(seen.map(item => item.type)).toEqual([
        'zerowall:attachment-open', 'zerowall:attachment-copy', 'zerowall:attachment-readd',
      ])
      expect(seen.map(item => item.detail.sessionId)).toEqual(['session-a', 'session-a', 'session-a'])
      expect(seen.map(item => item.detail.attachmentId)).toEqual([
        file.attachment.attachmentId, file.attachment.attachmentId, file.attachment.attachmentId,
      ])
      expect(seen[0]?.detail.cwd).toBe('C:/workspace')
      expect(screen.getByRole('status').textContent).toBe('文件已加入输入框')
    } finally {
      for (const action of ['open', 'copy', 'readd']) window.removeEventListener(`zerowall:attachment-${action}`, receive)
    }
  })

  it('shows a visible error when the file action is unavailable', () => {
    render(createElement(UserStyleBubble, { content: [file], renderMessageImages: () => null, fileActionScope: { sessionId: 'session-a' }, t }))
    fireEvent.click(screen.getByRole('button', { name: '复制文件' }))
    expect(screen.getByRole('alert').textContent).toBe('文件操作当前不可用。')
  })

  it('keeps uncommitted file echoes inert', () => {
    render(createElement(UserStyleBubble, { content: [file], renderMessageImages: () => null, t }))
    expect(screen.queryByRole('button', { name: '预览文件 history.pdf' })).toBeNull()
    expect(screen.queryByRole('button', { name: '重新添加到对话' })).toBeNull()
  })
})
