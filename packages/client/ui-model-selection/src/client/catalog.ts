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
  private requestVersion = 0
  private readonly targetVersions = new Map<string, number>()
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
    // Load metadata first so the selector becomes usable immediately. Health
    // probes are deliberately scheduled by the owning service and merged one
    // model at a time; a slow provider must not block model switching.
    const operation = this.session.modelCatalog({ refresh: true }).then((response) => {
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
  async checkAll(): Promise<ModelCatalog> {
    const base = await this.load()
    const generation = this.generation
    this.publishChecking(base, generation)
    let settled = false
    const operation = this.session.modelCatalog({ check: true, refresh: true })
    const poll = async (): Promise<void> => {
      while (!settled && generation === this.generation) {
        await delay(500)
        if (settled || generation !== this.generation) return
        try {
          const snapshot = await this.session.modelCatalog()
          if (snapshot.ok && generation === this.generation) {
            this.store.set({ value: snapshot.value, status: 'ready', error: null })
          }
        } catch { /* the owning check request reports transport failure */ }
      }
    }
    void poll()
    try {
      const response = await operation
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
      if (generation === this.generation) this.store.set({ value: response.value, status: 'ready', error: null })
      return response.value
    } catch (error) {
      if (generation === this.generation) {
        this.store.update((draft) => {
          draft.status = draft.value === null ? 'error' : 'ready'
          draft.error = error instanceof Error ? error.message : String(error)
        })
      }
      throw error
    } finally {
      settled = true
    }
  }

  /** Explicit user action: probe one exact provider/model route. */
  checkModel(provider: string, model: string): Promise<ModelCatalog> {
    return this.request({ check: true, refresh: true, provider, model })
  }

  private publishChecking(base: ModelCatalog, generation: number): void {
    if (generation !== this.generation) return
    this.store.set({
      value: {
        ...base,
        groups: base.groups.map(group => ({
          ...group,
          models: group.models.map(model => ({ ...model, status: 'checking' as const })),
        })),
      },
      status: 'ready',
      error: null,
    })
  }

  private request(request: {
    check?: boolean
    refresh?: boolean
    provider?: string
    model?: string
  }): Promise<ModelCatalog> {
    const targeted = request.provider !== undefined && request.model !== undefined
    const previous = this.store.getSnapshot()
    const key = targeted ? `${request.provider}:${request.model}` : undefined
    // A targeted probe must not put the shared catalog into the global
    // loading state. The existing value remains authoritative for every
    // other row while the caller's action button tracks the in-flight probe.
    this.store.update((draft) => {
      draft.status = targeted && previous.value !== null ? 'ready' : 'loading'
      draft.error = null
      if (targeted && draft.value !== null) {
        draft.value = {
          ...draft.value,
          groups: draft.value.groups.map(group => group.id !== request.provider
            ? group
            : {
              ...group,
              models: group.models.map(model => model.id !== request.model
                ? model
                : { ...model, status: 'checking' as const }),
            }),
        }
      }
    })
    const generation = this.generation
    const version = ++this.requestVersion
    if (key !== undefined) this.targetVersions.set(key, version)
    const operation = this.session.modelCatalog(request).then((response) => {
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
      const currentTarget = key === undefined || this.targetVersions.get(key) === version
      if (generation === this.generation && currentTarget) {
        if (targeted && previous.value !== null) {
          const current = this.store.getSnapshot().value ?? previous.value
          const next = response.value
          const provider = request.provider
          const model = request.model
          const groups = current.groups.map((group) => {
            if (group.id !== provider) return group
            const checked = next.groups.find(candidate => candidate.id === provider)?.models.find(candidate => candidate.id === model)
            return checked === undefined
              ? group
              : { ...group, models: group.models.map(entry => entry.id === model ? checked : entry) }
          })
          this.store.set({ value: { ...current, groups, failures: next.failures }, status: 'ready', error: null })
        } else {
          this.store.set({ value: response.value, status: 'ready', error: null })
        }
      }
      return response.value
    }).catch((error: unknown) => {
      if (generation === this.generation && (key === undefined || this.targetVersions.get(key) === version)) {
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
  refresh(check = false): void {
    this.invalidate()
    void (check ? this.checkAll() : this.sync()).catch(() => { /* the selector exposes the shared error */ })
  }

  /** Clear Host-specific values and load the replacement Host generation. */
  resetGeneration(): void {
    this.invalidate(true)
    void this.load().catch(() => { /* the selector exposes the shared error */ })
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
