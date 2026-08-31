/**
 * Per-session model directory: the ONE state both selection entries share.
 * The /model popup and composer seat combine one shared Host catalog with the
 * Session's durable selection projection, then submit through the same
 * selectModel call. A switch made in either entry updates this shared state.
 */
import type {
  ModelCatalogFailure, ModelProviderGroup, ModelSelection, ModelSelectionProjection,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelCatalogDirectory } from './catalog.ts'

/** Directory snapshot both entries render from. */
export interface ModelDirectoryState {
  /** Effective selection: durable next-request projection, then Host default. */
  current: ModelSelection | null
  /**
   * Whether an adapter serves the current selection's provider, as the host reports
   * it — null before the first load, which is NOT the same as blocked. Read
   * this rather than "current matches no group": catalog membership is
   * advisory, so a route serving a model it stopped advertising is missing
   * from the groups yet perfectly usable.
   */
  routable: boolean | null
  /** Successfully loaded provider groups (last good load). */
  groups: readonly ModelProviderGroup[]
  /** Provider-local failures from the last load; usable groups stay usable. */
  failures: readonly ModelCatalogFailure[]
  /** Lifecycle of the in-flight operation. */
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  /** Whole-request or selection failure text; null when none. */
  error: string | null
  /** Exact routes currently being probed. */
  checkingModels?: ReadonlySet<string>
  /** Whether a full catalog probe is in progress. */
  checkingAll?: boolean
  /** Whether a selectModel request is in flight. */
  selectionInFlight?: boolean
  /** Exact provider/model currently being submitted. */
  selectingKey: string | undefined
}

/** One session's shared directory controller; disposed with the session scope. */
export class ModelDirectory {
  /** The shared snapshot both entries render from (uSES-safe store). */
  readonly store: SnapshotStore<ModelDirectoryState> = createSnapshotStore<ModelDirectoryState>({
    current: null, routable: null, groups: [], failures: [], status: 'idle', error: null,
    checkingModels: new Set(), checkingAll: false, selectionInFlight: false, selectingKey: undefined,
  })

  /** Latest selection operation wins; an older response never overwrites a newer one. */
  private generation = 0
  private disposed = false
  private resolved = false
  /** Selection shown immediately while the durable projection catches up. */
  private optimisticSelection: ModelSelection | null = null
  private readonly unsubscribeCatalog: () => void
  private readonly unsubscribeSelection: () => void

  /**
   * @param sessions - the session wire face (captured from the plugin's root connection).
   * @param sessionId - the owning session.
   * @param available - whether this session may use Agent-bound model RPCs.
   * @param catalog - Host-generation catalog shared by every Session.
   * @param projected - durable model selection projected from Session history.
   */
  constructor(
    private readonly sessions: Pick<TypertClientRemote['session'], 'selectModel'>,
    private readonly sessionId: SessionId,
    private readonly available: () => boolean,
    private readonly catalog: ModelCatalogDirectory,
    private readonly projected: ObservableSnapshot<unknown>,
  ) {
    this.unsubscribeCatalog = catalog.store.subscribe(() => { this.syncInputs() })
    this.unsubscribeSelection = projected.subscribe(() => { this.syncInputs() })
    this.syncInputs()
  }

  /**
   * Ensure the Host generation's shared advisory catalog is loaded.
   * @returns the fresh directory value.
   */
  async load(): Promise<ModelDirectoryState> {
    this.assertAvailable()
    await this.catalog.load()
    this.syncInputs()
    return this.store.getSnapshot()
  }

  /** Explicit metadata synchronization shared by both model entries. */
  async sync(): Promise<ModelDirectoryState> {
    this.assertAvailable()
    await this.catalog.sync()
    this.syncInputs()
    return this.store.getSnapshot()
  }

  /** Explicitly probe every model and update both selector surfaces. */
  async checkAll(): Promise<ModelDirectoryState> {
    this.assertAvailable()
    await this.catalog.checkAll()
    this.syncInputs()
    return this.store.getSnapshot()
  }

  /** Explicitly probe one provider/model route. */
  async checkModel(provider: string, model: string): Promise<ModelDirectoryState> {
    this.assertAvailable()
    await this.catalog.checkModel(provider, model)
    this.syncInputs()
    return this.store.getSnapshot()
  }

  /**
   * Select the complete provider/model/reasoning selection. The durable
   * projection frame updates the shared current; failures surface on the store
   * and throw so each entry's own retry surface engages.
   * @param selection - provider, provider-owned model id, and optional adapter-owned effort.
 */
  async select(selection: ModelSelection): Promise<void> {
    this.assertAvailable()
    const generation = ++this.generation
    const selectingKey = `${selection.provider}:${selection.model}`
    const previous = this.store.getSnapshot().current
    this.optimisticSelection = selection
    this.store.update((s) => {
      s.current = selection
      s.status = 'ready'
      s.selectionInFlight = true
      s.selectingKey = selectingKey
      s.error = null
    })
    const result = await this.sessions.selectModel({
      sessionId: this.sessionId,
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: selection.reasoningEffort },
    })
    if (this.disposed || generation !== this.generation) {
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return
    }
    if (!result.ok) {
      this.optimisticSelection = null
      this.store.update((s) => {
        s.current = previous
        s.status = 'ready'
        s.selectionInFlight = false
        s.selectingKey = undefined
        s.error = `${result.error.code}: ${result.error.message}`
      })
      throw new Error(`session.selectModel failed: ${result.error.code}: ${result.error.message}`)
    }
    this.store.update((s) => {
      s.status = 'ready'
      s.selectionInFlight = false
      s.selectingKey = undefined
      s.error = null
    })
    // The projection normally publishes before this RPC settles. Keep the
    // optimistic value until that publication is observed so a slower
    // projection cannot make the trigger flash back to the old model.
    this.syncInputs()
  }

  /**
   * Invalidate an in-flight selection response from the previous Host generation.
   */
  resetConnected(): void {
    if (this.disposed) return
    ++this.generation
    this.optimisticSelection = null
    this.store.update((state) => {
      if (state.status === 'selecting') state.status = 'idle'
      state.selectionInFlight = false
      state.selectingKey = undefined
      state.error = null
    })
    this.syncInputs()
  }

  /** Scope teardown: late settlements lose write access to the store. */
  dispose(): void {
    this.disposed = true
    this.unsubscribeSelection()
    this.unsubscribeCatalog()
  }

  private assertAvailable(): void {
    if (!this.available()) {
      throw new Error('model selection is unavailable for addressed subagent sessions')
    }
  }

  private syncInputs(): void {
    if (this.disposed) return
    const catalog = this.catalog.store.getSnapshot()
    const projected = modelSelectionProjection(this.projected.getSnapshot())
    const projectedCurrent = projected?.next ?? projected?.lastUsed
    if (
      this.optimisticSelection !== null
      && sameSelection(projectedCurrent, this.optimisticSelection)
    ) this.optimisticSelection = null
    // A catalog transport failure must not erase the model that the Session
    // already selected. Keep it directly selectable while the catalog can be
    // retried, instead of leaving the composer with an empty model menu.
    if (catalog.status === 'error' && projectedCurrent !== null && projectedCurrent !== undefined) {
      const current = this.optimisticSelection ?? projectedCurrent
      this.resolved = true
      this.store.set({
        current,
        routable: true,
        groups: [],
        failures: [],
        status: 'ready',
        error: catalog.error,
        checkingModels: modelsChecking(catalog.value),
        checkingAll: false,
        selectionInFlight: this.store.getSnapshot().selectionInFlight === true,
        selectingKey: this.store.getSnapshot().selectingKey,
      })
      return
    }
    if (catalog.status !== 'ready' || catalog.value === null || projected === undefined) {
      if (this.resolved) {
        if (catalog.status === 'error') {
          this.store.update((state) => {
            state.status = 'error'
            state.error = catalog.error
          })
        }
        return
      }
      this.store.set({
        current: null,
        routable: null,
        groups: [],
        failures: [],
        status: catalog.status === 'error' ? 'error' : 'loading',
        error: catalog.error,
        checkingModels: modelsChecking(catalog.value),
        checkingAll: false,
        selectionInFlight: this.store.getSnapshot().selectionInFlight === true,
        selectingKey: this.store.getSnapshot().selectingKey,
      })
      return
    }
    const current = this.optimisticSelection ?? projected.next ?? catalog.value.default
    this.resolved = true
    this.store.set({
      current,
      routable: catalog.value.routableProviders.includes(current.provider),
      groups: catalog.value.groups,
      failures: catalog.value.failures,
      status: 'ready',
      error: null,
      checkingModels: modelsChecking(catalog.value),
      checkingAll: false,
      selectionInFlight: this.store.getSnapshot().selectionInFlight === true,
      selectingKey: this.store.getSnapshot().selectingKey,
    })
  }
}

function modelsChecking(value: import('@deepseek-ai/dsh-api-remotes/client').ModelCatalog | null): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const group of value?.groups ?? []) {
    for (const model of group.models) if (model.status === 'checking') keys.add(`${group.id}:${model.id}`)
  }
  return keys
}

function modelSelectionProjection(value: unknown): ModelSelectionProjection | undefined {
  return value === undefined ? undefined : value as ModelSelectionProjection
}

function sameSelection(left: ModelSelection | null | undefined, right: ModelSelection): boolean {
  return left !== null && left !== undefined
    && left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}
