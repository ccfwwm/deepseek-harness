/**
 * ModelDirectoryResolver (`ctx.modelDirectories`): the root owner of per-session
 * {@link ModelDirectory} instances. Both selection entries (the /model popup
 * and the composer model seat) resolve their session's directory through
 * this service, which is what makes the dual entry one shared state.
 *
 * Per-session storage follows the client service pattern (InputTriggerService /
 * CommandUiRuntime): a lazy service-internal map whose entry is deleted by the
 * owning scope's disposer. The host `dsh-scope` ScopedLayers registry does
 * does not belong here: it derives scope from the host carrier mechanism
 * (object-keyed), while client scopes tag contexts with branded SessionId
 * strings, and it models global+shadow named registries — this is a
 * per-session singleton with no global layer to merge.
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ModelCatalogDirectory } from './catalog.ts'
import { ModelDirectory } from './directory.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelDirectories: ModelDirectoryResolver
  }
}

/** Live mutable state in one holder (service methods run behind the caller-ctx tracker). */
interface LiveState {
  /** Per-session directories; entries are deleted by their scope disposer. */
  readonly directories: Map<SessionId, ModelDirectory>
}

/** The `ctx.modelDirectories` session model-selection service. */
export class ModelDirectoryResolver extends Service {
  static inject = ['sessions', 'remote', 'remote.session']

  private readonly live: LiveState = { directories: new Map() }
  private readonly catalog: ModelCatalogDirectory

  /** Localized composer-block copy; this plugin owns the string it raises. */
  private readonly blockReason: () => string
  private cancelScheduledCheck: (() => void) | undefined

  /**
   * @param ctx - owning root context (the service registers itself as `models`).
   * @param config - the bound translator for this plugin's own dictionary.
   */
  constructor(ctx: Context, config: { blockReason: () => string }) {
    super(ctx, 'modelDirectories')
    this.blockReason = config.blockReason
    this.catalog = new ModelCatalogDirectory(ctx.remote.session)
    // Publish metadata immediately. The health batch is posted at browser
    // background priority so plugin mounting and the first interactive work
    // reach the Host first.
    void this.catalog.load()
      .then(() => { this.scheduleBackgroundCheck() })
      .catch(() => { this.retryStartupLoad() })
    ctx.on('connection/reset', () => {
      // Keep the last known catalog/status across reconnects. Metadata is
      // refreshed in the background and health probes are started separately.
      this.catalog.resetGeneration()
      void this.catalog.load().then(() => { this.scheduleBackgroundCheck() }).catch(() => { this.retryStartupLoad() })
      for (const directory of this.live.directories.values()) directory.resetConnected()
    })
    ctx.remote.$on('llm/adapters-updated', () => { this.refreshInBackground() })
    ctx.remote.$on('api-session/model-catalog', (value) => { this.catalog.accept(value) })
    ctx.remote.$on('settings/document-updated', (namespace) => {
      const key = String(namespace)
      // selectModel persists the accepted default through this namespace. It
      // changes only the selection, not provider health, so probing every model
      // here would gray the menu and delay the close after every selection.
      if (key === 'agent-default-model') void this.catalog.refresh(false)
      else if (key.startsWith('llm-')) this.refreshInBackground()
    })
    ctx.remote.$on('credentials/reference-updated', () => { this.refreshInBackground() })
    ctx.effect(() => () => { this.cancelScheduledCheck?.() }, 'ui-model-selection: background model probe')
  }

  private retryStartupLoad(): void {
    this.cancelScheduledCheck?.()
    const timer = setTimeout(() => {
      void this.catalog.load().then(() => { this.scheduleBackgroundCheck() }).catch(() => { /* retry on next connection/reset */ })
    }, 1000)
    this.cancelScheduledCheck = () => clearTimeout(timer)
  }

  private refreshInBackground(): void {
    this.cancelScheduledCheck?.()
    void this.catalog.refresh(false)
      .catch(() => { /* selectors expose the shared error */ })
  }

  private scheduleBackgroundCheck(): void {
    this.cancelScheduledCheck?.()
    this.cancelScheduledCheck = postBackgroundTask(() => {
      this.cancelScheduledCheck = undefined
      void this.catalog.checkAll(true).catch(() => { /* selectors expose the shared error */ })
    })
  }

  /**
   * Resolve the per-session shared directory (lazy; the scope disposer
   * removes and disposes it). Unknown sessions fail loud.
   * @param sessionId - the owning session.
   * @returns the resident directory both entries share.
   */
  directoryFor(sessionId: SessionId): ModelDirectory {
    const { live } = this
    const existing = live.directories.get(sessionId)
    if (existing !== undefined) return existing
    const sessions = this.ctx.sessions
    const actx = sessions.scope(sessionId)
    if (actx === undefined) throw new Error(`ui-model-selection: session "${String(sessionId)}" resolved no scope`)
    const binding = sessions.binding(sessionId)
    if (binding === undefined) throw new Error(`ui-model-selection: session "${String(sessionId)}" resolved no binding`)
    const directory = new ModelDirectory(
      this.ctx.remote.session,
      sessionId,
      () => sessions.subagentAddress(sessionId) === undefined,
      this.catalog,
      binding.session.projections.faceOf('modelSelection'),
    )
    live.directories.set(sessionId, directory)
    // The composer cannot read this plugin (the dependency runs one way), so
    // the block is pushed: the Host says whether an adapter serves the
    // session's route, and only a definite `false` makes the input inert.
    // `null` — before the first load, or after one failed — must not, or a
    // slow or unreachable Host would lock a working composer.
    const conversation = this.ctx.get('conversation')
    if (conversation !== undefined) {
      const publish = (): void => {
        conversation.blocks.set(sessionId, directory.store.getSnapshot().routable === false
          ? { reason: this.blockReason() }
          : undefined)
      }
      publish()
      actx.effect(() => {
        const stop = directory.store.subscribe(publish)
        return () => {
          stop()
          conversation.blocks.set(sessionId, undefined)
        }
      }, 'ui-model-selection: composer block')
    }
    actx.effect(() => () => {
      directory.dispose()
      live.directories.delete(sessionId)
    }, 'ui-model-selection: session directory')
    return directory
  }
}

/** Schedule outside the plugin activation turn without Chromium scheduler starvation. */
function postBackgroundTask(task: () => void): () => void {
  const timer = setTimeout(task, 0)
  return () => { clearTimeout(timer) }
}
