/** Actions on durable attachments in the currently viewed Session. */
import { useState } from 'react'
import type { DragEvent } from 'react'
import { fileExtension, FileTypeIcon, fileSizeText, IconCopyOutlineRegular, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps, UserContentAttachment } from '../contract/slots.ts'
import css from './MessageItem.module.css'

export interface FileActionScope { readonly sessionId: string; readonly cwd?: string }
const HISTORY_ATTACHMENT_MIME = 'application/x-zerowall-history-attachment'

export function UserFileCard({ file, actionScope, t }: {
  file: Extract<UserContentAttachment, { type: 'file' }>['file']
  actionScope?: FileActionScope
  t: ChatViewSlotProps['t']
}) {
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null)
  const action = (kind: 'open' | 'copy' | 'readd'): void => {
    if (actionScope === undefined || busy) return
    setBusy(true)
    setFeedback(null)
    const complete = (success: boolean, error?: string): void => {
      setBusy(false)
      setFeedback(success
        ? kind === 'open' ? null : { error: false, text: t(kind === 'copy' ? 'message.fileCopied' : 'message.fileAdded') }
        : { error: true, text: error || t('message.fileActionFailed') })
    }
    const detail = {
      file,
      attachmentId: String(file.attachmentId),
      sessionId: actionScope.sessionId,
      ...(actionScope.cwd === undefined ? {} : { cwd: actionScope.cwd }),
      complete,
    }
    const event = new CustomEvent(`zerowall:attachment-${kind}`, { cancelable: true, detail })
    window.dispatchEvent(event)
    if (!event.defaultPrevented) complete(false, t('message.fileActionUnavailable'))
  }
  const nameAndSize = <>
    <FileTypeIcon path={file.name} className={css.fileIcon} />
    <span className={css.fileContent}>
      <span className={css.fileName}>{file.name}</span>
      <span className={css.fileMeta}>
        {[fileExtension(file.name).toUpperCase().slice(0, 8), fileSizeText(file.bytes)]
          .filter(Boolean).join(' ')}
      </span>
    </span>
  </>
  const startDrag = (event: DragEvent<HTMLDivElement>): void => {
    if (actionScope === undefined || busy) { event.preventDefault(); return }
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData(HISTORY_ATTACHMENT_MIME, JSON.stringify({
      sessionId: actionScope.sessionId,
      attachmentId: String(file.attachmentId),
    }))
  }
  return <div className={css.fileCard} title={file.name} draggable={actionScope !== undefined && !busy} onDragStart={startDrag}>
    {actionScope === undefined
      ? <span className={css.filePreviewButton}>{nameAndSize}</span>
      : <button type="button" className={css.filePreviewButton} disabled={busy} onClick={() => action('open')} aria-label={t('message.filePreview', { name: file.name })}>{nameAndSize}</button>}
    {actionScope !== undefined && <div className={css.fileActions}>
      <button type="button" disabled={busy} title={t('message.fileCopy')} aria-label={t('message.fileCopy')} onClick={() => action('copy')}><IconCopyOutlineRegular size={15} /></button>
      <button type="button" disabled={busy} title={t('message.fileReadd')} aria-label={t('message.fileReadd')} onClick={() => action('readd')}><IconPlusOutlineRegular size={15} /></button>
    </div>}
    {feedback !== null && <span className={feedback.error ? css.fileError : css.fileSuccess} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</span>}
  </div>
}
