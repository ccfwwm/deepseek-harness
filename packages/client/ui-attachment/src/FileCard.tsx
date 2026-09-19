import { fileExtension, FileTypeIcon, fileSizeText, IconCloseFill14 } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './FileCard.module.css'

/** Localized strings consumed by one pending-file card. */
export interface FileCardLabels {
  /** Card body announcement, e.g. "Pending file {name}". */
  readonly label: string
  /** Remove-button label. */
  readonly remove: string
  /** Status line while the upload is in flight. */
  readonly uploading: string
  /** Status line and retry affordance after a failed upload. */
  readonly failed: string
  /** Retry-button label. */
  readonly retry: string
  readonly parsingQueued: string
  readonly parsingRunning: string
  readonly parsingDone: string
  readonly parsingFailed: string
}

/** Upload display state resolved by the owner. */
export type FileCardState = 'uploading' | 'ready' | 'error'
export type FileParseState = 'queued' | 'running' | 'done' | 'failed'

/** One pending file card: type glyph, name, size or upload status, remove, retry. */
export function FileCard({
  name, bytes, state, progress, parseState, parseProgress, parseError, labels, onRemove, onRetry,
}: {
  name: string
  bytes: number
  state: FileCardState
  progress?: number
  parseState?: FileParseState | undefined
  parseProgress?: number | undefined
  parseError?: string | undefined
  labels: FileCardLabels
  onRemove: () => void
  onRetry: () => void
}) {
  const extension = fileExtension(name).toUpperCase().slice(0, 8)
  const uploadMeta = state === 'uploading'
    ? labels.uploading
    : state === 'error'
      ? labels.failed
      : [extension, fileSizeText(bytes)].filter(part => part !== '').join(' ')
  const parseMeta = parseState === 'queued'
    ? labels.parsingQueued
    : parseState === 'running'
      ? `${labels.parsingRunning}${parseProgress === undefined ? '' : ` ${Math.round(parseProgress)}%`}`
      : parseState === 'done'
        ? labels.parsingDone
        : parseState === 'failed'
          ? `${labels.parsingFailed}${parseError ? `: ${parseError}` : ''}`
          : undefined
  const meta = parseMeta ?? uploadMeta
  const retryable = state === 'error' || parseState === 'failed'
  return (
    <div
      className={`${css.card}${retryable ? ` ${css.failed}` : ''}`}
      title={name}
    >
      <span className={css.icon} aria-hidden>
        {state === 'uploading' || parseState === 'queued' || parseState === 'running'
          ? <span className={css.spinner} />
          : <FileTypeIcon path={name} />}
      </span>
      {retryable
        ? (
          <button type="button" className={`${css.body} ${css.retry}`} aria-label={labels.retry} onClick={onRetry}>
            <span className={css.name}>{name}</span>
            <span className={`${css.meta} ${css.metaFailed}`}>{meta}</span>
          </button>
        )
        : (
          <span className={css.body} aria-label={labels.label}>
            <span className={css.name}>{name}</span>
            <span className={css.meta}>{meta}</span>
          </span>
        )}
      <button
        type="button"
        className={retryable ? `${css.remove} ${css.removeFailed}` : css.remove}
        aria-label={labels.remove}
        onClick={onRemove}
      >
        <IconCloseFill14 size={12} />
      </button>
      {state === 'uploading' && (
        <span className={css.progressTrack} aria-hidden>
          <span
            className={css.progressBar}
            style={progress === undefined ? undefined : { width: `${String(Math.min(1, Math.max(0, progress)) * 100)}%` }}
          />
        </span>
      )}
      {state === 'ready' && (parseState === 'queued' || parseState === 'running') && (
        <span className={css.progressTrack} aria-label={meta}>
          <span className={css.progressBar} style={parseProgress === undefined ? undefined : { width: `${String(Math.min(1, Math.max(0, parseProgress / 100)) * 100)}%` }} />
        </span>
      )}
    </div>
  )
}
