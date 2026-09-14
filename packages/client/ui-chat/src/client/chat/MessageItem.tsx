import { Fragment, memo, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { PendingSubmission } from '@deepseek-ai/dsh-api-session-controller/client'
import type { MessageImageSource } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Button, IconCopyOutline16, IconCodeOutline16, IconRefreshOutline16, fileExtension, FileTypeIcon, fileSizeText, JsonBlock, projectUserText, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatFileAttachment, ChatNodeOwnerProps, ChatNodeViewProps, ChatViewSlotProps } from '../contract/slots.ts'
import type { ModelRetryNode, TurnErrorNode, UserMessageNode } from '../contract/snapshot.ts'
import { CompactionItem } from './CompactionItem.tsx'
import { ContextInjectionRow } from './ContextInjectionRow.tsx'
import { MessageIconActions } from './MessageIconActions.tsx'
import css from './MessageItem.module.css'

type UserImage = Extract<UserMessageNode['content'][number], { type: 'image' }>

type MutableChatFileAttachment = { -readonly [Key in keyof ChatFileAttachment]: ChatFileAttachment[Key] }

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' && value[key] !== '' ? value[key] as string : undefined
}

/** Normalize canonical and legacy file blocks before rendering the user row. */
function fileAttachmentFromBlock(block: unknown): ChatFileAttachment | undefined {
  if (block === null || typeof block !== 'object' || Array.isArray(block)) return undefined
  const value = block as Record<string, unknown>
  // Durable logs written by the current Host use `{ type: 'file', attachment }`.
  // Older replay/projection paths can retain a flat file DTO, or one extra
  // attachment wrapper. Walk all of these shapes so parsing metadata cannot
  // turn the file card into the generic "extra block" renderer.
  const hasFileIdentity = (record: Record<string, unknown>): boolean =>
    typeof record.attachmentId === 'string'
    && record.attachmentId.length > 0
    && (typeof record.name === 'string' || typeof record.mediaType === 'string')
  const sources: Record<string, unknown>[] = []
  const pending: Array<{ record: Record<string, unknown>; depth: number }> = [{ record: value, depth: 0 }]
  const seen = new Set<Record<string, unknown>>()
  while (pending.length > 0) {
    const next = pending.shift()
    if (next === undefined || seen.has(next.record)) continue
    seen.add(next.record)
    sources.push(next.record)
    if (next.depth >= 5) continue
    for (const key of ['attachment', 'file', 'metadata', 'ref', 'data']) {
      const nested = next.record[key]
      if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
        pending.push({ record: nested as Record<string, unknown>, depth: next.depth + 1 })
      }
    }
  }
  // Some older projection records wrap the DTO in an envelope without a
  // `type: file` tag. Only classify the block as a file when one of the
  // expanded records carries the durable attachment identity.
  if (value.type !== 'file' && !sources.some(hasFileIdentity)) return undefined
  const firstString = (key: string): string | undefined => {
    for (const source of sources) {
      const found = stringField(source, key)
      if (found !== undefined) return found
    }
    return undefined
  }
  const firstNumber = (key: string): number | undefined => {
    for (const source of sources) {
      if (typeof source[key] === 'number') return source[key] as number
    }
    return undefined
  }
  const attachmentId = firstString('attachmentId')
  if (attachmentId === undefined) return undefined
  const name = firstString('name') ?? 'uploaded-file'
  const mediaType = firstString('mediaType') ?? 'application/octet-stream'
  const bytes = firstNumber('bytes') ?? 0
  const attachment: MutableChatFileAttachment = {
    attachmentId,
    name,
    mediaType,
    bytes,
  }
  const parser = firstString('parser')
  const status = firstString('status')
  const textChars = firstNumber('textChars')
  const pageCount = firstNumber('pageCount')
  const sheetCount = firstNumber('sheetCount')
  const preview = firstString('preview')
  const contentText = firstString('content')
  const parseStatus = firstString('parseStatus')
  const parseProgress = firstNumber('parseProgress')
  const parseError = firstString('parseError')
  if (parser !== undefined) attachment.parser = parser
  if (status !== undefined) attachment.status = status
  if (textChars !== undefined) attachment.textChars = textChars
  if (pageCount !== undefined) attachment.pageCount = pageCount
  if (sheetCount !== undefined) attachment.sheetCount = sheetCount
  if (preview !== undefined) attachment.preview = preview
  if (contentText !== undefined) attachment.content = contentText
  if (parseStatus !== undefined) attachment.parseStatus = parseStatus as Exclude<ChatFileAttachment['parseStatus'], undefined>
  if (parseProgress !== undefined) attachment.parseProgress = parseProgress
  if (parseError !== undefined) attachment.parseError = parseError
  return attachment
}
type PresentedAttachment =
  | { readonly type: 'image'; readonly image: MessageImageSource }
  | { readonly type: 'file'; readonly file: ChatFileAttachment }

function contentParts(content: readonly unknown[]): {
  text: string
  attachments: PresentedAttachment[]
  rest: unknown[]
} {
  const texts: string[] = []
  const attachments: PresentedAttachment[] = []
  const rest: unknown[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: string; attachment?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else if (b.type === 'image' && b.attachment !== undefined) {
      attachments.push({ type: 'image', image: { attachment: (b as UserImage).attachment } })
    }
    else {
      const file = fileAttachmentFromBlock(block)
      if (file !== undefined) attachments.push({ type: 'file', file })
      else rest.push(block)
    }
  }
  return { text: texts.join(''), attachments, rest }
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
function TurnErrorItem({ node, retryTurn, t }: {
  node: TurnErrorNode
  retryTurn?: (turn: number) => Promise<void>
  t: ChatViewSlotProps['t']
}) {
  const [retrying, setRetrying] = useState(false)
  const onRetry = async (): Promise<void> => {
    if (retryTurn === undefined || retrying) return
    setRetrying(true)
    try {
      await retryTurn(node.turn)
    } catch {
      // Keep the terminal failure visible so a later click can retry again.
    } finally {
      setRetrying(false)
    }
  }
  return (
    <div className={css.turnErrorRow} role="status">
      <StateDot state="error" className={css.turnErrorDot} />
      <div className={css.turnErrorCopy}>
        <span className={css.turnErrorTitle}>{t('message.turnError')}</span>
        <span className={css.turnErrorMessage}>{failureMessage(node.message, node.code, t)}</span>
      </div>
      {node.code !== undefined && <code className={css.turnErrorCode}>{node.code}</code>}
      {retryTurn !== undefined && (
        <Button
          variant="outline"
          size="sm"
          className={css.turnErrorRetry}
          icon={<IconRefreshOutline16 />}
          disabled={retrying}
          onClick={() => { void onRetry() }}
          aria-label={t(retrying ? 'message.turnError.retrying' : 'message.turnError.retry')}
        >
          {t(retrying ? 'message.turnError.retrying' : 'message.turnError.retry')}
        </Button>
      )}
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
  content, renderMessageImages, actions, pending = false, echo = false, referenceLabels = [], skillNames = [],
  previewAttachments, sessionId, openAttachment, openParsedAttachment, copyAttachment, t,
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
  /** Skill names the step's `skill-invocation` injections loaded for this message. */
  skillNames?: readonly string[]
  /** Local submission-echo attachments replacing the content-derived attachment sequence. */
  previewAttachments?: readonly PresentedAttachment[]
  t: ChatViewSlotProps['t']
}): ReactNode {
  const { text, attachments: contentAttachments, rest } = contentParts(content)
  const attachments = previewAttachments ?? contentAttachments
  const compactImages = attachments.length > 1
  const truncated = (total: number): string => t('json.truncated', { total })
  const showBubble = text !== '' || rest.length > 0
  return (
    <div
      className={css.userRow}
      data-pending-steering={pending || undefined}
      data-submission-echo={echo || undefined}
    >
      <div className={css.userStack}>
        {attachments.length > 0 && (
          <div className={css.attachmentRow} data-message-attachments>
            {attachments.map((attachment, index) => attachment.type === 'image'
              ? (
                <Fragment key={`image:${index}`}>
                  {renderMessageImages({
                    images: [attachment.image],
                    align: 'end',
                    compact: compactImages,
                  })}
                </Fragment>
              )
              : (
                <span key={`file:${index}`} className={css.fileCard} title={attachment.file.name} draggable onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'copy'
                  event.dataTransfer.setData('application/x-zerowall-attachment', JSON.stringify({ ...attachment.file, sessionId }))
                  event.dataTransfer.setData('text/plain', attachment.file.name)
                }}>
                  <button type="button" className={css.fileOpen} title={t('attachment.preview')} disabled={openAttachment === undefined} onClick={() => openAttachment?.(attachment.file)}>
                    <FileTypeIcon path={attachment.file.name} className={css.fileIcon} />
                    <span className={css.fileContent}>
                      <span className={css.fileName}>{attachment.file.name}</span>
                      <span className={css.fileMeta}>
                        {[fileExtension(attachment.file.name).toUpperCase().slice(0, 8), fileSizeText(attachment.file.bytes)]
                          .filter(Boolean).join(' ')}
                      </span>
                    </span>
                  </button>
                  <button type="button" className={css.fileOpen} title={t('attachment.parsed')} disabled={openParsedAttachment === undefined} onClick={() => openParsedAttachment?.(attachment.file)}><IconCodeOutline16 /></button>
                  <button type="button" className={css.fileCopy} title={t('attachment.copy')} aria-label={t('attachment.copy')} disabled={copyAttachment === undefined} onClick={() => copyAttachment?.(attachment.file)}><IconCopyOutline16 /></button>
                  {attachment.file.parseStatus !== undefined && attachment.file.parseStatus !== 'idle' && (
                    <span className={css.fileStatus} role="status">{t(`attachment.${attachment.file.parseStatus}`)}{attachment.file.parseStatus === 'failed' && attachment.file.parseError ? `: ${attachment.file.parseError}` : ''}</span>
                  )}
                </span>
              ))}
          </div>
        )}
        {showBubble && <div className={css.bubble}>
          {projectUserText(text, referenceLabels, skillNames)}
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
      ...(submission.text === '' ? [] : [{ type: 'text', text: submission.text }]),
    ],
    [submission.text],
  )
  const previewAttachments = useMemo<readonly PresentedAttachment[]>(
    () => submission.attachments.map(attachment => attachment.type === 'image'
      ? {
        type: 'image',
        image: {
          preview: {
            url: attachment.value.previewUrl,
            ...(attachment.value.name === undefined ? {} : { name: attachment.value.name }),
            ...(attachment.value.width === undefined ? {} : { width: attachment.value.width }),
            ...(attachment.value.height === undefined ? {} : { height: attachment.value.height }),
          },
        },
      }
      : { type: 'file', file: { ...attachment.value, mediaType: 'application/octet-stream' } }),
    [submission.attachments],
  )
  return (
    <UserStyleBubble
      content={content}
      previewAttachments={previewAttachments}
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
      {...data.skillNames === undefined ? {} : { skillNames: data.skillNames }}
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
export const TurnErrorNodeView = memo(function TurnErrorNodeView({ node, retryTurn, t }: ChatNodeViewProps<'turn-error'>) {
  return <TurnErrorItem node={node.data} {...retryTurn === undefined ? {} : { retryTurn }} t={t} />
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
