import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** Client-side alias retained for ZeroWall's transport-boundary handling. */
export type ClientFailure = RemoteFailure
export type ClientResult<T> = RemoteResult<T>

/** Fold an unexpected local/transport throw into the generated Remote error face. */
export function transportResult<T>(error: unknown): ClientResult<T> {
  if (isRemoteFailure(error)) return { ok: false, error }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { ok: false, error: new RemoteError('gateway/cancelled', error.message || 'request cancelled', {}) }
  }
  return {
    ok: false,
    error: new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {}),
  }
}

function isRemoteFailure(error: unknown): error is RemoteFailure {
  return typeof error === 'object' && error !== null
    && (error as { isDSHRemoteError?: unknown }).isDSHRemoteError === true
    && typeof (error as { code?: unknown }).code === 'string'
}
