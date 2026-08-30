/** One Host-generation model catalog shared by every Session selector. */

import type { ClientRemote, ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Observable lifecycle of the shared model catalog. */
export interface ModelCatalogState {
  value: ModelCatalog | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
}

/** Loads at most one model catalog for the current Host generation. */
export class ModelCatalogDirectory {
  /** Current shared catalog value and load lifecycle. */
  readonly store: SnapshotStore<ModelCatalogState> = createSnapshotStore({
    value: null,
    status: 'idle',
    error: null,
  })

  private generation = 0
  private inflight: Promise<ModelCatalog> | undefined

  /** @param session - Session Remote namespace carrying the Host-generation catalog. */
  constructor(private readonly session: Pick<ClientRemote['session'], 'modelCatalog'>) {}

  /**
   * Return the current generation's catalog, sharing its one in-flight load.
   * @returns the loaded global catalog.
   */
  load(): Promise<ModelCatalog> {
    const state = this.store.getSnapshot()
    if (state.status === 'ready' && state.value !== null) return Promise.resolve(state.value)
    if (this.inflight !== undefined) return this.inflight
    const generation = this.generation
    this.store.update((draft) => {
      draft.status = 'loading'
      draft.error = null
    })
    // The first load belongs to Host startup. It performs the one real text
    // and vision probe and is then shared by settings and every selector.
    const operation = this.session.modelCatalog({ check: true }).then((response) => {
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      if (generation === this.generation) {
        this.store.set({ value: response.value, status: 'ready', error: null })
      }
      return response.value
    }).catch((error: unknown) => {
      if (generation === this.generation) {
        this.store.update((draft) => {
          draft.status = 'error'
          draft.error = error instanceof Error ? error.message : String(error)
        })
      }
      throw error
    }).finally(() => {
      if (generation === this.generation && this.inflight === operation) this.inflight = undefined
    })
    this.inflight = operation
    return operation
  }

  /** Explicitly refresh provider metadata without probing every model. */
  sync(): Promise<ModelCatalog> {
    return this.request({ refresh: true })
  }

  /** Explicit user action: probe every model in the current Host generation. */
  checkAll(): Promise<ModelCatalog> {
    return this.request({ check: true, refresh: true })
  }

  /** Explicit user action: probe one exact provider/model route. */
  checkModel(provider: string, model: string): Promise<ModelCatalog> {
    return this.request({ check: true, refresh: true, provider, model })
  }

  private request(request: {
    check?: boolean
    refresh?: boolean
    provider?: string
    model?: string
  }): Promise<ModelCatalog> {
    const targeted = request.provider !== undefined && request.model !== undefined
    const previous = this.store.getSnapshot()
    // A targeted probe must not put the shared catalog into the global
    // loading state. The existing value remains authoritative for every
    // other row while the caller's action button tracks the in-flight probe.
    this.store.update((draft) => {
      draft.status = targeted && previous.value !== null ? 'ready' : 'loading'
      draft.error = null
    })
    const generation = this.generation
    const operation = this.session.modelCatalog(request).then((response) => {
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
      if (generation === this.generation) {
        this.store.set({ value: response.value, status: 'ready', error: null })
      }
      return response.value
    }).catch((error: unknown) => {
      if (generation === this.generation) {
        this.store.update((draft) => {
          draft.status = targeted && previous.value !== null ? 'ready' : 'error'
          draft.error = error instanceof Error ? error.message : String(error)
        })
      }
      throw error
    })
    return operation
  }

  /**
   * Invalidate the loaded catalog; the next explicit menu read reloads it.
   * @param clear - whether values from the previous Host generation must be hidden.
   */
  private invalidate(clear = false): void {
    this.generation += 1
    this.inflight = undefined
    const value = clear ? null : this.store.getSnapshot().value
    this.store.set({ value, status: 'idle', error: null })
  }

  /** Invalidate and reload the catalog after a Host-side model input changes. */
  refresh(): void {
    this.invalidate()
    void this.sync().catch(() => { /* the selector exposes the shared error */ })
  }

  /** Clear Host-specific values and load the replacement Host generation. */
  resetGeneration(): void {
    this.invalidate(true)
    void this.load().catch(() => { /* the selector exposes the shared error */ })
  }
}
