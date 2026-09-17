/** Session Remote owner: cold reads, explicit Agent commands, and live control state. */

import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import z from '@deepseek-ai/schemastery'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import { canOpenNativePath, nativeFileManager, openNativePath, revealNativePath } from '@deepseek-ai/dsh-native-command'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  ApiSessionAgentController,
  inspectApiSession,
  type ApiSessionAgentResult,
} from './agent.ts'
import { SessionCommandController } from './commands.ts'
import { SessionControlController } from './control.ts'
import { SessionHistoryController } from './history.ts'
import { SessionFileReferences } from './file-references.ts'
import { ApiSessionList } from './list.ts'
import { BACKGROUND_PROBE_CONCURRENCY, buildModelCatalog, invalidateModelCatalog } from './catalog.ts'
import { installModelSelectionProjection } from './model-selection-projection.ts'
import { SessionSkillCatalog } from './skill-catalog.ts'
import { SessionMediaReferences } from './media-references.ts'
import type {
  SessionDeleteRequest, SessionDeletePrepared, SessionDeleteFinish,
  ModelCatalog,
  SessionAttachmentRequest,
  SessionAttachmentValue,
  SessionCancelRequest,
  SessionCancelValue,
  SessionControlFrame,
  SessionCreateRequest,
  SessionCreateValue,
  SessionFollowFrame,
  SessionFollowRequest,
  SessionForkRequest,
  SessionForkValue,
  SessionListRequest,
  SessionListValue,
  SessionOpenWorkspacePathRequest,
  SessionOpenWorkspacePathValue,
  SessionPage,
  SessionPageRequest,
  SessionPromptRequest,
  SessionPromptValue,
  SessionRenameRequest,
  SessionRenameValue,
  SessionSearchRequest,
  SessionSearchValue,
  SessionSelectModelRequest,
  SessionSelectModelValue,
  SessionUpdateQueueRequest,
  SessionUpdateQueueValue,
} from './types.ts'

export type * from './types.ts'
export { ApiSessionNotFound } from './agent.ts'
export { SessionFileReferences } from './file-references.ts'
export { SessionSkillCatalog } from './skill-catalog.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Session business API and Remote namespace owner. */
    sessionController: SessionController
  }
}

/** Session Controller deployment policy. */
export interface Config {
  /** Override platform desktop-opener detection. */
  readonly nativeOpen?: boolean
  /** Per-provider model discovery deadline in milliseconds. */
  readonly modelCatalogTimeoutMs?: number
}

/** Host integrations replaceable by direct unit tests. */
export interface SessionControllerInternals {
  /** Native default-application handoff. */
  readonly openPath?: (path: string, signal: AbortSignal) => Promise<void>
  /** Native file-manager handoff. */
  readonly revealPath?: (path: string, signal: AbortSignal) => Promise<void>
  /** Native handoff availability probe. */
  readonly canOpenPath?: () => boolean
}

/** Host service backing the generated `ctx.remote.session` namespace. */
export class SessionController extends TypertRemoteService {
  static inject = [
    'agentDefaultModel',
    'agents',
    'attachments',
    'fileUploads',
    'llm',
    'sessions',
    'sessionProjections',
    'sessionQuery',
    'typert',
    'workspaceRegistry',
  ]

  static Config: z<Config> = z.object({
    nativeOpen: z.boolean(),
    modelCatalogTimeoutMs: z.natural().min(1).max(120_000).default(15_000),
  })

  private readonly agents: ApiSessionAgentController
  private readonly commands: SessionCommandController
  private readonly controlState: SessionControlController
  private readonly history: SessionHistoryController
  private readonly listState: ApiSessionList
  private readonly openPath: (path: string, signal: AbortSignal) => Promise<void>
  private readonly revealPath: (path: string, signal: AbortSignal) => Promise<void>
  private readonly canOpenPath: () => boolean
  private readonly deletions = new Map<SessionId, string>()
  private readonly operations = new Map<SessionId, Set<Promise<unknown>>>()

  private operation<T>(id: SessionId, run: () => Promise<T>): Promise<T> {
    this.agents.assertAvailable(id)
    const pending = this.operations.get(id) ?? new Set<Promise<unknown>>()
    this.operations.set(id, pending)
    const result = Promise.resolve().then(run)
    pending.add(result)
    void result.finally(() => { pending.delete(result); if (!pending.size) this.operations.delete(id) }).catch(() => {})
    return result
  }

  private readonly promotions = new Map<Promise<void>, SessionId>()
  private readonly completedDeletions = new Map<SessionId, string>()
  /** One low-resource automatic probe per Host process, shared by every browser/reconnect. */
  private startupModelProbe: Promise<ModelCatalog> | undefined
  private readonly modelCatalogTimeoutMs: number

  /**
   * @param ctx - Host context containing the Session capability assembly.
   * @param config - native-opener deployment policy.
   * @param internals - host integrations replaceable by direct unit tests.
   */
  constructor(ctx: Context, config: Config, internals: SessionControllerInternals = {}) {
    super(ctx, 'sessionController', { namespace: 'session' })
    this.modelCatalogTimeoutMs = config.modelCatalogTimeoutMs ?? 15_000
    installModelSelectionProjection(ctx)
    this.agents = new ApiSessionAgentController(ctx)
    this.commands = new SessionCommandController(ctx, this.agents, undefined)
    ctx.effect(() => ctx.fileUploads.registerAgentResolver(async (sessionId) => {
      const result = await this.agents.resolveAgent(sessionId)
      if ('error' in result) throw result.error
      return result.agent
    }), 'session-controller: file-upload Agent resolver')
    this.controlState = new SessionControlController(ctx)
    // Registered before history so reverse-order teardown closes every
    // follower before waiting for already-admitted promotions.
    ctx.effect(() => async () => {
      await Promise.allSettled([...this.promotions.keys()])
    }, 'session-controller.promotions')
    this.history = new SessionHistoryController(ctx, (observation) => { this.promote(observation) })
    this.listState = new ApiSessionList(ctx)
    this.openPath = internals.openPath ?? openNativePath
    this.revealPath = internals.revealPath ?? revealNativePath
    this.canOpenPath = internals.canOpenPath
      ?? (() => config.nativeOpen ?? (internals.openPath !== undefined || canOpenNativePath()))
    ctx.plugin(SessionFileReferences)
    ctx.plugin(SessionMediaReferences)
    ctx.plugin(SessionSkillCatalog)

    ctx.on('session/created', (session) => {
      ctx.emit('api-session/added', this.listState.summaryFor(session))
    })
    // A provider/settings/credential generation change invalidates the one
    // Host-generation catalog. The next explicit read performs the new
    // startup-style check; opening a selector never probes by itself.
    ctx.on('llm/adapters-updated', () => { invalidateModelCatalog(ctx) })
    ctx.on('settings/updated', (namespace: string) => {
      const key = String(namespace)
      if (key.startsWith('llm-')) invalidateModelCatalog(ctx)
    })
    ctx.on('session/disposed', (session) => {
      if (!this.deletions.has(session.id)) ctx.emit('api-session/removed', session.id)
    })
    ctx.on('agent/status', ({ agent, status }) => {
      ctx.emit('api-session/status', agent.id, status === 'running')
    })
    ctx.on('agent/error', ({ agent, error }) => {
      ctx.emit('api-session/error', agent.id, errorChain(error))
    })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'request/header') {
        const agent = ctx.agents.get(session.id)
        if (agent?.session === session) this.agents.consumeSelection(
          agent,
          event.data.header.config.provider,
          event.data.header.config.model,
          event.data.header.config.reasoningEffort,
        )
      }
      if (event.type !== 'user/message' || event.data.source.kind !== 'user') return
      ctx.emit('api-session/activity', session.id, event.time)
    })
  }

  private promote(observation: SessionObservation): void {
    const sessionId = observation.header.id
    const task = (async () => {
      using ownedObservation = observation
      const result = await this.agents.resolveObservedAgent(ownedObservation)
      if ('error' in result) this.ctx.emit('api-session/error', sessionId, result.error.message)
    })().catch((error: unknown) => {
      this.ctx.logger.error(`session-controller: background activation for "${sessionId}" failed: ${errorChain(error)}`)
    })
    this.promotions.set(task, sessionId)
    void task.finally(() => { this.promotions.delete(task) })
  }

  /**
   * Resolve or resume one ordinary Session for another Host API domain.
   * @param sessionId - Session identity whose Agent owns the operation.
   * @returns the live Agent or the stable Session-domain failure.
   */
  resolveAgent(sessionId: SessionId): Promise<ApiSessionAgentResult> {
    return this.agents.resolveAgent(sessionId)
  }

  /**
   * Inspect one attached or persisted Session without activating its Agent.
   * @param sessionId - durable Session identity.
   * @param signal - optional caller cancellation for persistence reads.
   * @returns the current attached state or persisted header and event prefix.
   */
  inspect(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionInspection> {
    this.agents.assertAvailable(sessionId)
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined) {
      return Promise.resolve({
        meta: attached.header,
        inheritedEventCount: attached.inheritedEventCount,
        events: attached.snapshotEvents(),
      })
    }
    return inspectApiSession(this.ctx, sessionId, signal)
  }

  /**
   * Prepare one local deletion while unrelated agents keep running.
   * @param request - target durable identity.
   * @returns a single-use capability and the backend-resolved storage directory.
   */
  @Remote('prepareDelete')
  async prepareDelete(request: SessionDeleteRequest): Promise<SessionDeletePrepared> {
    const id = request.sessionId
    this.agents.assertAvailable(id)
    const token = randomUUID()
    this.deletions.set(id, token)
    this.agents.deleting.add(id)
    try {
      await Promise.allSettled([
        ...(this.operations.get(id) ?? []),
        ...[...this.promotions].filter(([, target]) => target === id).map(([task]) => task),
      ])
      const related = new Set<SessionId>([id])
      let changed = true
      while (changed) {
        changed = false
        for (const session of this.ctx.sessions.list()) {
          if (session.header.origin === 'subagent' && session.header.parentSession !== undefined && related.has(session.header.parentSession) && !related.has(session.id)) {
            related.add(session.id); changed = true
          }
        }
      }
      if ([...related].some(key => this.ctx.agents.get(key)?.status === 'running')) {
        throw new RemoteError('session/agent-busy', 'Wait for this session and its tasks to finish.', { reason: 'Wait for this session and its tasks to finish.' })
      }
      const persistence = this.ctx.get('sessionPersistence') as (typeof this.ctx.sessionPersistence & {
        resolveStoredDirectory?: (key: SessionId) => Promise<string | undefined>
      }) | undefined
      if (persistence?.resolveStoredDirectory === undefined) throw new Error('Desktop deletion requires file session storage.')
      await this.history.closeSession(id)
      await this.agents.releaseForDeletion(id)
      await this.ctx.get('sessionProjectionCache')?.forget(id)
      const path = await persistence.resolveStoredDirectory(id)
      if (path === undefined) throw new RemoteError('session/not-found', 'Stored session not found.', { sessionId: id })
      return { token, path }
    } catch (error) {
      this.deletions.delete(id); this.agents.deleting.delete(id)
      this.ctx.emit('api-session/restored', id)
      throw error
    }
  }

  /**
   * Publish deletion after the desktop has trashed the data; repeated commits are idempotent.
   * @param request - identity and preparation capability.
   * @returns completion after absence is verified and removal published.
   */
  @Remote('commitDelete')
  async commitDelete(request: SessionDeleteFinish): Promise<void> {
    if (this.completedDeletions.get(request.sessionId) === request.token) return
    this.verifyDeletion(request)
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('Session storage unavailable.')
    if (await persistence.stat(request.sessionId) !== undefined) throw new Error('Session data still exists.')
    this.deletions.delete(request.sessionId)
    this.agents.deleting.delete(request.sessionId)
    this.completedDeletions.set(request.sessionId, request.token)
    this.ctx.emit('api-session/removed', request.sessionId)
  }

  /**
   * Unlock after a failed trash operation, reconciling a lost commit if data is absent.
   * @param request - identity and preparation capability.
   * @returns completion after clients can access the surviving data again.
   */
  @Remote('abortDelete')
  async abortDelete(request: SessionDeleteFinish): Promise<void> {
    if (this.completedDeletions.get(request.sessionId) === request.token) return
    this.verifyDeletion(request)
    // A lost commit response must not resurrect data already moved to the trash.
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('Session storage unavailable.')
    if (await persistence.stat(request.sessionId) === undefined) {
      await this.commitDelete(request)
      return
    }
    this.deletions.delete(request.sessionId)
    this.agents.deleting.delete(request.sessionId)
    this.ctx.emit('api-session/restored', request.sessionId)
  }

  private verifyDeletion(request: SessionDeleteFinish): void {
    if (this.deletions.get(request.sessionId) !== request.token) throw new Error('Deletion capability expired or mismatched.')
  }

  /**
   * Read visible rows without resuming an Agent; omit prepared deletions.
   * @param _request - reserved empty request.
   * @param signal - cancellation for persistence reads.
   * @returns visible summaries ordered by activity.
   */
  @Remote('list')
  async list(_request: SessionListRequest, signal: AbortSignal): Promise<SessionListValue> {
    return { items: (await this.listState.list(signal)).filter(item => !this.deletions.has(item.sessionId)) }
  }

  /**
   * Search visible Session content without resuming an Agent.
   * @param request - literal message-content query.
   * @param signal - cancellation for list and search reads.
   * @returns authorized bounded Session search results.
   */
  @Remote('search')
  search(request: SessionSearchRequest, signal: AbortSignal): Promise<SessionSearchValue> {
    return this.listState.search(request.query, signal)
  }

  /**
   * Create or idempotently adopt one ordinary Session.
   * @param request - requested identity, location, and Agent preset.
   * @returns the Session identity and resolved preset when configured.
   */
  @Remote('create')
  create(request: SessionCreateRequest): Promise<SessionCreateValue> {
    return request.sessionId === undefined
      ? this.commands.create(request)
      : this.operation(request.sessionId, () => this.commands.create(request))
  }

  /**
   * Select one Session-local model after explicitly resuming the Session.
   * @param request - Session identity and requested model selection.
   * @returns the normalized selection installed for the Session.
   */
  @Remote('selectModel')
  selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue> {
    return this.operation(request.sessionId, () => this.commands.selectModel(request))
  }

  /**
   * Describe every currently routable model for Host-generation selectors.
   * @param request - optional explicit health-check request; metadata-only when omitted.
   * @returns provider-grouped models, the deployment default, and isolated provider failures.
   */
  @Remote('modelCatalog')
  modelCatalog(request?: {
    readonly check?: boolean
    readonly refresh?: boolean
    /** Low-resource startup probe; explicit user checks omit this flag. */
    readonly background?: boolean
    readonly provider?: string
    readonly model?: string
  }): Promise<ModelCatalog> {
    const metadataOptions = { metadataTimeoutMs: this.modelCatalogTimeoutMs }
    if (request?.background !== true) return buildModelCatalog(this.ctx, undefined, { ...request, ...metadataOptions })
    if (this.startupModelProbe !== undefined) {
      // A later browser or reconnect receives the current metadata plus the
      // persisted health produced by the first probe. It never starts a new
      // inference fan-out, even if provider metadata invalidated the catalog.
      return this.startupModelProbe.then(
        () => buildModelCatalog(this.ctx, undefined, metadataOptions),
        () => buildModelCatalog(this.ctx, undefined, metadataOptions),
      )
    }
    const { background: _background, ...options } = request
    // This is a separate startup RPC, not the metadata request that opens the
    // selector. Events provide progress; the response remains authoritative
    // even when an embedded transport drops those events.
    const operation = buildModelCatalog(this.ctx, undefined, {
      ...options,
      ...metadataOptions,
      concurrency: BACKGROUND_PROBE_CONCURRENCY,
    })
    this.startupModelProbe = operation
    return operation
  }

  /**
   * Report whether this deployment can hand a Session workspace path to a native desktop.
   * @returns true when the matching open operation is available.
   */
  @Remote
  canOpenWorkspacePath(): boolean {
    return this.canOpenPath()
  }

  /**
   * Describe the serving desktop for authenticated file-action routes.
   * @returns Host name, configured availability, and platform-specific file-manager behavior.
   */
  workspaceDesktop(): { name: string; available: boolean; fileManager: 'finder' | 'explorer' | 'directory' | null } {
    const fileManager = nativeFileManager()
    return { name: hostname(), available: fileManager !== null && this.canOpenPath(), fileManager }
  }

  /**
   * Open one path prepared by a Session-aware caller on the Host desktop.
   * @param request - path after best-effort Session workspace resolution.
   * @param signal - caller lifetime; abort terminates the native command.
   * @returns confirmation after the native opener accepts the path.
   * @throws RemoteError when the request is invalid, cancelled, or the opener fails.
   */
  @Remote('openWorkspacePath')
  async openWorkspacePath(
    request: SessionOpenWorkspacePathRequest,
    signal: AbortSignal,
  ): Promise<SessionOpenWorkspacePathValue> {
    if (request.path.length === 0) {
      throw new RemoteError(
        'gateway/bad-request',
        'session.openWorkspacePath requires a non-empty path',
        {},
      )
    }
    signal.throwIfAborted()
    try {
      if (request.action === 'reveal') await this.revealPath(request.path, signal)
      else await this.openPath(request.path, signal)
      return { opened: true }
    } catch (error: unknown) {
      if (signal.aborted) throw new RemoteError('gateway/cancelled', 'path open was aborted', {})
      throw new RemoteError(
        'gateway/internal',
        `path open failed: ${error instanceof Error ? error.message : String(error)}`,
        {},
      )
    }
  }

  /**
   * Rename one Session after explicitly resuming it.
   * @param request - Session identity and proposed title.
   * @returns the accepted title and durable event sequence.
   */
  @Remote('rename')
  rename(request: SessionRenameRequest): Promise<SessionRenameValue> {
    return this.operation(request.sessionId, () => this.commands.rename(request))
  }

  /**
   * Fork one cold-readable completed-turn prefix into a new Session.
   * @param request - source Session and optional event anchor.
   * @returns the new Session identity.
   */
  @Remote('fork')
  fork(request: SessionForkRequest): Promise<SessionForkValue> {
    return this.operation(request.sessionId, () => this.commands.fork(request))
  }

  /**
   * Admit one prompt after explicitly resuming its Session.
   * @param request - Session identity, prompt content, source metadata, and delivery mode.
   * @param signal - caller cancellation before prompt admission begins.
   * @returns acknowledgement that the Agent accepted the prompt.
   */
  @Remote('prompt')
  prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue> {
    signal.throwIfAborted()
    return this.operation(request.sessionId, () => this.commands.prompt(request))
  }

  /**
   * Read one image proven reachable from the addressed Session log.
   * @param request - Session and attachment identities used for authorization.
   * @returns the durable attachment reference and base64-encoded bytes.
   */
  @Remote('attachment')
  attachment(request: SessionAttachmentRequest): Promise<SessionAttachmentValue> {
    return this.operation(request.sessionId, () => this.commands.attachment(request))
  }

  /**
   * Mutate one still-pending queue occurrence on a live Agent.
   * @param request - Session, queue item, and requested mutation.
   * @returns acknowledgement that the queue mutation was applied.
   */
  @Remote('updateQueue')
  updateQueue(request: SessionUpdateQueueRequest): SessionUpdateQueueValue {
    this.agents.assertAvailable(request.sessionId)
    return this.commands.updateQueue(request)
  }

  /**
   * Cancel one active Agent turn without dropping its pending inbox.
   * @param request - Session whose active Agent turn is cancelled.
   * @returns acknowledgement that cancellation was requested.
   */
  @Remote('cancel')
  cancel(request: SessionCancelRequest): SessionCancelValue {
    this.agents.assertAvailable(request.sessionId)
    return this.commands.cancel(request)
  }

  /**
   * Read one cold-safe, message-aligned Session history page.
   * @param request - durable address, backward cursor, and page budget.
   * @param signal - cancellation for persistence reads.
   * @returns one chronological page.
   */
  @Remote('page')
  page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage> {
    const id = request.address.kind === 'session' ? request.address.sessionId : request.address.childSessionId
    return this.operation(id, () => this.history.page(request, signal))
  }

  /**
   * Follow one Session log from its opening or resume cursor.
   * @param request - durable address and last committed sequence already held by the caller.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns a complete opening snapshot followed by gap-free durable event
   *   frames and optional cursorless assistant-stream frames.
   */
  @Remote({ mode: 'stream' })
  async *follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    const id = request.address.kind === 'session' ? request.address.sessionId : request.address.childSessionId
    this.agents.assertAvailable(id)
    yield* this.history.follow(request, signal)
  }

  /**
   * Stream a complete live-control baseline followed by replacement frames.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns one complete baseline followed by live replacement frames.
   */
  @Remote({ mode: 'stream' })
  control(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    return this.controlState.control(signal)
  }

}

export { buildModelCatalog }
export default SessionController
