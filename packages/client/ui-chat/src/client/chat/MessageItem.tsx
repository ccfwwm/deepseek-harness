import { memo, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { PendingSubmission } from '@deepseek-ai/dsh-api-session-controller/client'
import type { MessageImageSource } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { IconArchiveOutline20, IconBrowseOutline16, IconCodeOutline16, IconCopyOutline16, IconDataOutline16, IconFolderClose16, JsonBlock, projectUserText, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatFileAttachment, ChatNodeOwnerProps, ChatNodeViewProps, ChatViewSlotProps } from '../contract/slots.ts'
import type { ModelRetryNode, TurnErrorNode, UserMessageNode } from '../contract/snapshot.ts'
import { CompactionItem } from './CompactionItem.tsx'
import { ContextInjectionRow } from './ContextInjectionRow.tsx'
import { MessageIconActions } from './MessageIconActions.tsx'
import css from './MessageItem.module.css'

type UserImage = Extract<UserMessageNode['content'][number], { type: 'image' }>

function contentParts(content: readonly unknown[]): {
  text: string
  images: { attachment: UserImage['attachment'] }[]
  files: ChatFileAttachment[]
  rest: unknown[]
} {
  const texts: string[] = []
  const images: { attachment: UserImage['attachment'] }[] = []
  const files: ChatFileAttachment[] = []
  const rest: unknown[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: string; attachment?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else if (b.type === 'image' && b.attachment !== undefined) {
      images.push({ attachment: (b as UserImage).attachment })
    }
    else if (b.type === 'file' && b.attachment !== undefined && typeof b.attachment === 'object') {
      const attachment = b.attachment as Partial<ChatFileAttachment>
      if (typeof attachment.attachmentId === 'string' && typeof attachment.name === 'string') files.push({
        attachmentId: attachment.attachmentId,
        name: attachment.name,
        mediaType: typeof attachment.mediaType === 'string' ? attachment.mediaType : 'application/octet-stream',
        bytes: typeof attachment.bytes === 'number' ? attachment.bytes : 0,
        ...(typeof attachment.parser === 'string' ? { parser: attachment.parser } : {}),
        ...(typeof attachment.status === 'string' ? { status: attachment.status } : {}),
        ...(typeof attachment.textChars === 'number' ? { textChars: attachment.textChars } : {}),
        ...(typeof attachment.pageCount === 'number' ? { pageCount: attachment.pageCount } : {}),
        ...(typeof attachment.sheetCount === 'number' ? { sheetCount: attachment.sheetCount } : {}),
        ...(typeof attachment.preview === 'string' ? { preview: attachment.preview } : {}),
        ...(typeof attachment.parseStatus === 'string' ? { parseStatus: attachment.parseStatus as ChatFileAttachment['parseStatus'] } : {}),
        ...(typeof attachment.parseProgress === 'number' ? { parseProgress: attachment.parseProgress } : {}),
        ...(typeof attachment.parseError === 'string' ? { parseError: attachment.parseError } : {}),
      })
      else rest.push(block)
    }
    else rest.push(block)
  }
  return { text: texts.join(''), images, files, rest }
}

function fileIconFor(file: ChatFileAttachment): ReactNode {
  const extension = file.name.split('.').pop()?.toLocaleLowerCase() ?? ''
  if (file.mediaType.includes('zip') || file.mediaType.includes('compressed') || ['zip', '7z', 'rar', 'tar', 'gz'].includes(extension)) return <IconArchiveOutline20 size={22} />
  if (file.mediaType.includes('json') || file.mediaType.includes('javascript') || ['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go'].includes(extension)) return <IconCodeOutline16 size={22} />
  if (file.mediaType.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(extension)) return <IconBrowseOutline16 size={22} />
  if (file.mediaType.includes('spreadsheet') || file.mediaType.includes('excel') || ['xls', 'xlsx', 'csv'].includes(extension)) return <IconDataOutline16 size={22} />
  if (file.mediaType.includes('presentation') || ['ppt', 'pptx', 'key'].includes(extension)) return <IconFolderClose16 size={22} />
  return <IconDataOutline16 size={22} />
}

function FileCards({ files, sessionId, openAttachment, openParsedAttachment, copyAttachment }: {
  files: readonly ChatFileAttachment[]
  sessionId?: string
  openAttachment?: ((attachment: ChatFileAttachment) => void) | undefined
  openParsedAttachment?: ((attachment: ChatFileAttachment) => void) | undefined
  copyAttachment?: ((attachment: ChatFileAttachment) => void) | undefined
}): ReactNode {
  if (files.length === 0) return null
  return <div className={css.fileCards} role="list" aria-label="附件">
    {files.map(file => <div className={css.fileCard} role="listitem" key={file.attachmentId} draggable onDragStart={(event) => {
      event.dataTransfer.effectAllowed = 'copy'
      event.dataTransfer.setData('application/x-zerowall-attachment', JSON.stringify({ attachmentId: file.attachmentId, name: file.name, mediaType: file.mediaType, sessionId }))
      event.dataTransfer.setData('text/plain', file.name)
    }}>
      <button type="button" className={css.fileOpen} onClick={() => openAttachment?.(file)} disabled={openAttachment === undefined} title="预览附件">
        <span className={css.fileIcon} aria-hidden>{fileIconFor(file)}</span>
        <span className={css.fileName}>{file.name}</span>
      </button>
      <button type="button" className={css.fileOpen} onClick={() => openParsedAttachment?.(file)} disabled={openParsedAttachment === undefined} title="查看解析结果">
        <span className={css.fileIcon} aria-hidden>↗</span>
      </button>
      <button type="button" className={css.fileCopy} onClick={() => copyAttachment?.(file)} disabled={copyAttachment === undefined} title="复制附件" aria-label="复制附件">
        <IconCopyOutline16 />
      </button>
      {(file.parseStatus === 'running' || file.parseStatus === 'queued') && <div className={css.fileProgress} role="status" aria-label="附件解析中">
        <span style={{ width: `${Math.max(6, Math.min(100, file.parseProgress ?? 12))}%` }} />
      </div>}
    </div>)}
  </div>
}

function retrySeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1_000))
}

interface RetryCountdown {
  deadline: number
  seconds: number
}

function failureMessage(
  message: string,
  code: unknown,
  t: ChatViewSlotProps['t'],
): string {
  return code === 'AUTH' ? t('message.failure.auth') : message
}

function ModelRetryItem({ node, active, t }: {
  node: ModelRetryNode
  active: boolean
  t: ChatViewSlotProps['t']
}) {
  // Anchor the host-scheduled delay to this browser's first render of the
  // retry node. Host event time and Date.now() may belong to different clocks.
  const deadline = useMemo(() => Date.now() + node.delayMs, [node.delayMs, node.seq])
  const scheduledSeconds = retrySeconds(node.delayMs)
  const maximum = node.mode === 'normal' ? node.maxRetries : '∞'
  const [countdown, setCountdown] = useState<RetryCountdown>(() => ({
    deadline,
    seconds: retrySeconds(deadline - Date.now()),
  }))
  const remainingSeconds = countdown.deadline === deadline
    ? countdown.seconds
    : retrySeconds(deadline - Date.now())

  useEffect(() => {
    if (!active) return
    const updateCountdown = (): number => {
      const next = retrySeconds(deadline - Date.now())
      setCountdown(current => (
        current.deadline === deadline && current.seconds === next
          ? current
          : { deadline, seconds: next }
      ))
      return next
    }
    if (updateCountdown() === 1) return
    const timer = window.setInterval(() => {
      if (updateCountdown() === 1) window.clearInterval(timer)
    }, 250)
    return () => { window.clearInterval(timer) }
  }, [active, deadline])

  const label = active
    ? t('message.retry.active')
    : node.retryState === 'cancelled'
      ? t('message.retry.cancelled')
      : node.retryState === 'started'
        ? t('message.retry.started')
        : t('message.retry.scheduled')
  const seconds = active ? remainingSeconds : scheduledSeconds

  return (
    <details className={css.retryRow} data-active={active || undefined}>
      <summary className={css.retrySummary}>
        <span className={css.retryText} role="status">
          {t('message.retry.status', { label, retry: node.retry, maximum, seconds })}
        </span>
      </summary>
      <div className={css.retryDetails}>
        <div>
          <span className={css.retryDetailLabel}>{t('message.retry.delay')}</span>
          {t('duration.milliseconds', { milliseconds: Math.round(node.delayMs) })}
        </div>
        <div>
          <span className={css.retryDetailLabel}>{t('message.retry.failure')}</span>
          {failureMessage(node.failure.message, node.failure.code, t)}
        </div>
      </div>
    </details>
  )
}

/** Persistent, turn-positioned feedback for a terminal failure. */
function TurnErrorItem({ node, t }: {
  node: TurnErrorNode
  t: ChatViewSlotProps['t']
}) {
  return (
    <div className={css.turnErrorRow} role="status">
      <StateDot state="error" className={css.turnErrorDot} />
      <div className={css.turnErrorCopy}>
        <span className={css.turnErrorTitle}>{t('message.turnError')}</span>
        <span className={css.turnErrorMessage}>{failureMessage(node.message, node.code, t)}</span>
      </div>
      {node.code !== undefined && <code className={css.turnErrorCode}>{node.code}</code>}
    </div>
  )
}

/** Persistent, turn-positioned notice for a turn ended at the output-token cap. */
function TurnMaxTokensItem({ t }: {
  t: ChatViewSlotProps['t']
}) {
  return (
    <div className={css.turnErrorRow} role="status">
      <StateDot state="warning" className={css.turnErrorDot} />
      <div className={css.turnErrorCopy}>
        <span className={css.maxTokensTitle}>{t('message.maxTokens')}</span>
        <span className={css.turnErrorMessage}>{t('message.maxTokens.hint')}</span>
      </div>
    </div>
  )
}

/** Right-aligned bubble shared by user and steering rows. */
function UserStyleBubble({
  content, sessionId, renderMessageImages, openAttachment, openParsedAttachment,
  copyAttachment, actions, pending = false, echo = false, referenceLabels = [], previewImages, t,
}: {
  content: readonly unknown[]
  sessionId?: string
  renderMessageImages: ChatNodeOwnerProps['renderMessageImages']
  openAttachment?: ChatNodeOwnerProps['openAttachment']
  openParsedAttachment?: ChatNodeOwnerProps['openParsedAttachment']
  copyAttachment?: ChatNodeOwnerProps['copyAttachment']
  /** Optional IconActions (or similar) below the bubble; receives the joined text. */
  actions?: (text: string) => ReactNode
  /** Whether this is the Host-authoritative pre-admission steering projection. */
  pending?: boolean
  /** Whether this is a local submission echo (invisible marker; the echo renders exactly like its durable replacement). */
  echo?: boolean
  /** Exact session mention labels associated by the adjacent recall node. */
  referenceLabels?: readonly string[]
  /** Local submission-echo previews replacing the content-derived image group. */
  previewImages?: readonly MessageImageSource[]
  t: ChatViewSlotProps['t']
}): ReactNode {
  const { text, images: contentImages, files, rest } = contentParts(content)
  const images = previewImages ?? contentImages
  const truncated = (total: number): string => t('json.truncated', { total })
  const showBubble = text !== '' || rest.length > 0
  return (
    <div
      className={css.userRow}
      data-pending-steering={pending || undefined}
      data-submission-echo={echo || undefined}
    >
      <div className={css.userStack}>
        {renderMessageImages({ images, align: 'end' })}
        <FileCards
          files={files}
          sessionId={sessionId}
          openAttachment={openAttachment}
          openParsedAttachment={openParsedAttachment}
          copyAttachment={copyAttachment}
        />
        {showBubble && <div className={css.bubble}>
          {projectUserText(text, referenceLabels)}
          {rest.map((block, i) => <JsonBlock key={i} label={t('message.extraBlock')} payload={block} truncatedLabel={truncated} />)}
        </div>}
        {referenceLabels.length > 0 && (
          <div className={css.referenceSummary}>
            {t('message.referenceSummary', { labels: referenceLabels.join(t('message.referenceSeparator')) })}
          </div>
        )}
      </div>
      {actions?.(text)}
    </div>
  )
}

/**
 * Render one Host-authoritative pending steering item with the same visual
 * language as its eventual durable transcript node.
 * @param props - Pending message content and conversation translator.
 * @returns the pending steering bubble.
 */
export function PendingSteeringBubble({ content, renderMessageImages, t }: {
  content: readonly unknown[]
  renderMessageImages: ChatNodeOwnerProps['renderMessageImages']
  t: ChatViewSlotProps['t']
}): ReactNode {
  return (
    <UserStyleBubble
      content={content}
      openAttachment={undefined}
      renderMessageImages={renderMessageImages}
      pending
      t={t}
      actions={text => (
        <MessageIconActions
          text={text}
          clock="start"
          className={css.actions}
          t={t}
        />
      )}
    />
  )
}

/**
 * Render one local transcript or steering submission echo with the same
 * visual language and surface marker as the Host occurrence that replaces
 * it: draft text plus object-URL previews, visible from the submit click
 * until the durable `user/message` or steering occurrence renders.
 * @param props - the session snapshot's pending submission and render seats.
 * @returns the echoed user bubble.
 */
export function PendingSubmissionBubble({ submission, renderMessageImages, t }: {
  submission: PendingSubmission
  renderMessageImages: ChatNodeOwnerProps['renderMessageImages']
  t: ChatViewSlotProps['t']
}): ReactNode {
  const content = useMemo(
    () => [
      ...(submission.files ?? []).map((file, index) => ({ type: 'file', attachment: { attachmentId: `pending:${index}`, name: file.name, mediaType: file.mediaType, bytes: 0 } })),
      ...(submission.text === '' ? [] : [{ type: 'text', text: submission.text }]),
    ],
    [submission.files, submission.text],
  )
  const previewImages = useMemo<readonly MessageImageSource[]>(
    () => submission.images.map(image => ({
      preview: {
        url: image.previewUrl,
        ...(image.name === undefined ? {} : { name: image.name }),
        ...(image.width === undefined ? {} : { width: image.width }),
        ...(image.height === undefined ? {} : { height: image.height }),
      },
    })),
    [submission.images],
  )
  return (
    <UserStyleBubble
      content={content}
      previewImages={previewImages}
      renderMessageImages={renderMessageImages}
      pending={submission.placement === 'steering'}
      echo
      t={t}
      actions={text => (
        <MessageIconActions
          text={text}
          time={submission.time}
          clock="start"
          className={css.actions}
          t={t}
        />
      )}
    />
  )
}

/** User and admitted-steering keyed Chat renderer. */
export const UserMessageNodeView = memo(function UserMessageNodeView({
  node, sessionId, renderMessageImages, openAttachment, openParsedAttachment, copyAttachment, t,
}: ChatNodeViewProps<'user' | 'steering'>) {
  const data = node.data
  return (
    <UserStyleBubble
      content={data.content}
      sessionId={sessionId}
      renderMessageImages={renderMessageImages}
      openAttachment={openAttachment}
      openParsedAttachment={openParsedAttachment}
      copyAttachment={copyAttachment}
      {...data.referenceLabels === undefined ? {} : { referenceLabels: data.referenceLabels }}
      t={t}
      actions={text => (
        <MessageIconActions
          text={text}
          time={data.time}
          clock="start"
          className={css.actions}
          t={t}
        />
      )}
    />
  )
})

/** Injected-context keyed Chat renderer. */
export const ContextMessageNodeView = memo(function ContextMessageNodeView({ node, t }: ChatNodeViewProps<'context'>) {
  const data = node.data
  return (
    <ContextInjectionRow
      content={data.content}
      source={data.source}
      provenance={data.provenance}
      form={data.form}
      t={t}
    />
  )
})

/** Automatic compaction keyed Chat renderer. */
export const CompactionNodeView = memo(function CompactionNodeView({ node, t }: ChatNodeViewProps<'compaction'>) {
  return <CompactionItem node={node.data} t={t} />
})

/** Correlated retry-chain keyed Chat renderer. */
export const RetryNodeView = memo(function RetryNodeView({ node, t }: ChatNodeViewProps<'model-retry'>) {
  const data = node.data
  return <ModelRetryItem node={data.current} active={data.current.retryState === 'scheduled'} t={t} />
})

/** Terminal turn-error keyed Chat renderer. */
export const TurnErrorNodeView = memo(function TurnErrorNodeView({ node, t }: ChatNodeViewProps<'turn-error'>) {
  return <TurnErrorItem node={node.data} t={t} />
})

/** Max-tokens turn-end notice keyed Chat renderer. */
export const TurnMaxTokensNodeView = memo(function TurnMaxTokensNodeView({ t }: ChatNodeViewProps<'turn-max-tokens'>) {
  return <TurnMaxTokensItem t={t} />
})

/** Explicit unknown-surface keyed Chat renderer. */
export const UnknownNodeView = memo(function UnknownNodeView({ node, t }: ChatNodeViewProps<'unknown'>) {
  const data = node.data
  return (
    <div className={css.contextRow}>
      <JsonBlock
        label={t('message.unknownSurface', { type: data.type })}
        payload={data.data}
        truncatedLabel={total => t('json.truncated', { total })}
      />
    </div>
  )
})
