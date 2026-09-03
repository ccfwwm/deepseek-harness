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
  private checkInflight: Promise<ModelCatalog> | undefined
  private backgroundInflight: Promise<ModelCatalog> | undefined

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
    const operation = this.session.modelCatalog().then((response) => {
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
  checkAll(background = false): Promise<ModelCatalog> {
    const resident = background ? this.backgroundInflight : this.checkInflight
    if (resident !== undefined) return resident
    if (background) this.markCheckingAll()
    const operation = this.runIncrementalCheck(background).finally(() => {
      if (background) {
        if (this.backgroundInflight === operation) this.backgroundInflight = undefined
      } else if (this.checkInflight === operation) this.checkInflight = undefined
    })
    if (background) this.backgroundInflight = operation
    else this.checkInflight = operation
    return operation
  }

  private async runIncrementalCheck(background: boolean): Promise<ModelCatalog> {
    if (background) {
      const generation = this.generation
      const response = await this.session.modelCatalog({ check: true, refresh: true, background: true })
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
      if (generation === this.generation) {
        // Embedded transports can return the metadata snapshot without
        // forwarding the incremental probe events. Keep the visible
        // "checking" state until a probe result arrives instead of replacing
        // it with a second batch of "unknown" rows.
        const current = this.store.getSnapshot().value
        this.accept(current === null ? response.value : preserveChecking(current, response.value))
      }
      return response.value
    }
    const catalog = await this.load()
    const generation = this.generation
    const targets = catalog.groups.flatMap(group => group.models.map(model => ({ provider: group.id, model: model.id })))
    const failures: unknown[] = []
    await mapWithConcurrency(targets, 8, async ({ provider, model }) => {
      try {
        await this.probeModel(provider, model, false)
      } catch (error) {
        failures.push(error)
      }
    })
    if (generation !== this.generation) return catalog
    const value = this.store.getSnapshot().value ?? catalog
    if (!background && failures.length === targets.length && failures[0] !== undefined) throw failures[0]
    return value
  }

  /** Explicit user action: probe one exact provider/model route. */
  checkModel(provider: string, model: string): Promise<ModelCatalog> {
    return this.probeModel(provider, model, true)
  }

  /** Merge a Host-pushed incremental probe result into every selector. */
  accept(value: ModelCatalog): void {
    const current = this.store.getSnapshot().value
    this.store.set({ value: current === null ? value : mergeCatalog(current, value), status: 'ready', error: null })
  }

  /** Mark startup rows immediately so asynchronous probes are observable. */
  private markCheckingAll(): void {
    const current = this.store.getSnapshot().value
    if (current === null) return
    this.store.set({
      value: {
        ...current,
        groups: current.groups.map(group => ({
          ...group,
          models: group.models.map(model => ({ ...model, status: 'checking' as const })),
        })),
      },
      status: 'ready',
      error: null,
    })
  }

  private probeModel(provider: string, model: string, markChecking: boolean): Promise<ModelCatalog> {
    return this.request({ check: true, refresh: true, provider, model }, markChecking)
  }

  private request(request: {
    check?: boolean
    refresh?: boolean
    provider?: string
    model?: string
  }, markChecking = true): Promise<ModelCatalog> {
    const targeted = request.provider !== undefined && request.model !== undefined
    const previous = this.store.getSnapshot()
    const key = targeted ? `${request.provider}:${request.model}` : undefined
    // A targeted probe must not put the shared catalog into the global
    // loading state. The existing value remains authoritative for every
    // other row while the caller's action button tracks the in-flight probe.
    this.store.update((draft) => {
      draft.status = targeted && previous.value !== null ? 'ready' : 'loading'
      draft.error = null
      if (targeted && markChecking && draft.value !== null) {
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
    this.checkInflight = undefined
    this.backgroundInflight = undefined
    const value = clear ? null : this.store.getSnapshot().value
    this.store.set({ value, status: 'idle', error: null })
  }

  /** Invalidate and reload the catalog after a Host-side model input changes. */
  refresh(check = false): Promise<ModelCatalog> {
    this.invalidate()
    const operation = check ? this.checkAll() : this.sync()
    void operation.catch(() => { /* the selector exposes the shared error */ })
    return operation
  }

  /** Clear Host-specific values and load the replacement Host generation. */
  resetGeneration(): void {
    // Preserve the last good directory while the replacement Host generation
    // is handshaking. Selectors remain usable during reconnect and receive the
    // new metadata atomically once it is available.
    this.invalidate(false)
    void this.load().catch(() => { /* the selector exposes the shared error */ })
  }
}

function preserveChecking(current: ModelCatalog, incoming: ModelCatalog): ModelCatalog {
  return {
    ...incoming,
    groups: incoming.groups.map((group) => {
      const previous = current.groups.find(candidate => candidate.id === group.id)
      if (previous === undefined) return group
      return {
        ...group,
        models: group.models.map((model) => {
          const prior = previous.models.find(candidate => candidate.id === model.id)
          return prior?.status === 'checking' && (model.status === undefined || model.status === 'unknown')
            ? { ...model, status: 'checking' as const }
            : model
        }),
      }
    }),
  }
}

/** Merge out-of-order catalog events without regressing a completed probe. */
function mergeCatalog(current: ModelCatalog, incoming: ModelCatalog): ModelCatalog {
  return {
    ...incoming,
    groups: incoming.groups.map((group) => {
      const previous = current.groups.find(candidate => candidate.id === group.id)
      if (previous === undefined) return group
      return {
        ...group,
        models: group.models.map((model) => {
          const prior = previous.models.find(candidate => candidate.id === model.id)
          if (prior === undefined) return model
          if (prior.lastCheckedAt !== undefined
            && model.lastCheckedAt !== undefined
            && prior.lastCheckedAt > model.lastCheckedAt) return prior
          if (model.status === undefined || model.status === 'unknown' || model.status === 'checking') {
            if (prior.status !== undefined && prior.status !== 'unknown' && prior.status !== 'checking') return prior
          }
          return model
        }),
      }
    }),
  }
}

async function mapWithConcurrency<T>(values: readonly T[], concurrency: number, task: (value: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= values.length) return
      const value = values[index]
      if (value === undefined) return
      await task(value)
    }
  })
  await Promise.all(workers)
}
