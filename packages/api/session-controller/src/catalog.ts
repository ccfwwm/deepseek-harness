/** Shared projection of the live LLM registry into the browser model catalog. */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { LlmModelInfo, LlmProbeAttempt, LlmVisionProbeResult } from '@deepseek-ai/dsh-llm'
import type {
  ModelAvailability,
  ModelCatalog,
  ModelCatalogModel,
  ModelReasoning,
  ModelSelection,
  ModelVisionStatus,
} from './types.ts'

export interface ModelCatalogOptions {
  /** Perform real provider text and image probes instead of only syncing metadata. */
  readonly check?: boolean
  /** Per-probe timeout. */
  readonly timeoutMs?: number
  /** Maximum model probes running at once. */
  readonly concurrency?: number
  /** Bypass the current Host-generation cache for an explicit user refresh. */
  readonly refresh?: boolean
  /** Probe one exact route instead of every model. */
  readonly provider?: string
  readonly model?: string
}

// Gateways behind Sub2API can spend several seconds on cold routing and
// authentication. Eight seconds made healthy models appear unavailable; the
// explicit check remains bounded while matching the account client's 20s cap.
const DEFAULT_PROBE_TIMEOUT_MS = 120_000
const DEFAULT_PROBE_CONCURRENCY = 8
/** Startup probes yield network capacity to conversations, Skills, MCP, and file work. */
export const BACKGROUND_PROBE_CONCURRENCY = 2

interface CatalogCache {
  value?: ModelCatalog
  checked: boolean
  metadataInflight?: Promise<ModelCatalog> | undefined
  checkInflight?: Promise<ModelCatalog> | undefined
  visionSupported: Set<string>
  health: Map<string, PersistedModelHealth>
  hydration?: Promise<void> | undefined
  persistTail?: Promise<void> | undefined
}

interface PersistedModelHealth {
  status: ModelAvailability
  statusMessage?: string
  visionStatus?: ModelVisionStatus
  visionMessage?: string
  lastCheckedAt: number
}

const catalogCaches = new WeakMap<object, CatalogCache>()

/** Build the browser model catalog without requiring a Session. */
export async function buildModelCatalog(
  ctx: Context,
  defaultSelection: ModelSelection = ctx.agentDefaultModel.currentSelection(),
  options: ModelCatalogOptions = {},
): Promise<ModelCatalog> {
  const cache = catalogCacheFor(ctx)
  await hydrateHealth(cache)
  const targeted = options.provider !== undefined || options.model !== undefined
  if (options.check !== true) {
    if (options.refresh !== true && cache.value !== undefined) return cache.value
    if (cache.metadataInflight !== undefined) return cache.metadataInflight
    const operation = buildModelCatalogUncached(ctx, defaultSelection, {}).then(value => mergeHealth(value, cache.health))
    cache.metadataInflight = operation
    try {
      const value = await operation
      if (cache.value === undefined) cache.value = value
      return value
    } finally {
      if (cache.metadataInflight === operation) cache.metadataInflight = undefined
    }
  }
  if (!targeted && options.refresh !== true && cache.checked && cache.value !== undefined) return cache.value
  if (!targeted && cache.checkInflight !== undefined) return cache.checkInflight
  if (targeted) {
    const base = cache.value ?? await buildModelCatalog(ctx, defaultSelection, {})
    const checkedValue = await checkOneModel(ctx, base, options)
    const checked = checkedValue.groups
      .find(group => group.id === options.provider)?.models
      .find(model => model.id === options.model)
    const value = checked === undefined || options.provider === undefined || options.model === undefined
      ? (cache.value ?? checkedValue)
      : replaceModel(cache.value ?? base, options.provider, options.model, checked)
    cache.value = value
    captureHealth(cache, value)
    await persistHealth(cache)
    ctx.emit('api-session/model-catalog', value)
    // A targeted probe only establishes one row. Keep the generation marked
    // as partially checked so the next startup/explicit all-model check still
    // probes every remaining model instead of treating unknown rows as fresh.
    return value
  }
  const operation = checkAllModels(ctx, defaultSelection, options)
  cache.checkInflight = operation
  try {
    const value = await operation
    cache.value = value
    cache.checked = true
    captureHealth(cache, value)
    await persistHealth(cache)
    ctx.emit('api-session/model-catalog', value)
    return value
  } finally {
    if (cache.checkInflight === operation) cache.checkInflight = undefined
  }
}

async function checkAllModels(
  ctx: Context,
  defaultSelection: ModelSelection,
  options: ModelCatalogOptions,
): Promise<ModelCatalog> {
  const cache = catalogCacheFor(ctx)
  const base = cache.value ?? await buildModelCatalogUncached(ctx, defaultSelection, {})
  // Keep the last known row states visible while probes run. The caller owns
  // the batch progress indicator; replacing every row with "checking" makes
  // the selector look unavailable and destroys useful startup history.
  cache.value = base
  const targets = base.groups.flatMap(group => group.models.map(model => ({
    provider: group.id,
    model,
  })))
  await mapWithConcurrency(targets, options.concurrency ?? DEFAULT_PROBE_CONCURRENCY, async (target) => {
    const checked = await modelEntry(ctx, target.provider, {
      provider: target.provider,
      id: target.model.id,
      name: target.model.name,
      ...(target.model.description === undefined ? {} : { description: target.model.description }),
      ...(target.model.inputModalities === undefined ? {} : { inputModalities: [...target.model.inputModalities] }),
    }, { ...options, check: true })
    const entry = target.model.reasoning === undefined ? checked : { ...checked, reasoning: target.model.reasoning }
    cache.value = replaceModel(cache.value ?? base, target.provider, target.model.id, entry)
    // Stream each completed row so the UI never waits for the slowest model.
    ctx.emit('api-session/model-catalog', cache.value)
  })
  return cache.value ?? base
}

function replaceModel(
  catalog: ModelCatalog,
  provider: string,
  model: string,
  entry: ModelCatalogModel,
): ModelCatalog {
  return {
    ...catalog,
    groups: catalog.groups.map(group => group.id !== provider
      ? group
      : { ...group, models: group.models.map(candidate => candidate.id === model ? entry : candidate) }),
  }
}

/** Drop the cached catalog when a provider/settings generation changes. */
export function invalidateModelCatalog(ctx: Context): void {
  const cache = catalogCaches.get(ctx as object)
  if (cache === undefined) return
  if (cache.value !== undefined) captureHealth(cache, cache.value)
  delete cache.value
  cache.checked = false
  delete cache.metadataInflight
  delete cache.checkInflight
}

function catalogCacheFor(ctx: Context): CatalogCache {
  const key = ctx as object
  const existing = catalogCaches.get(key)
  if (existing !== undefined) return existing
  const created: CatalogCache = { checked: false, visionSupported: new Set(), health: new Map() }
  catalogCaches.set(key, created)
  return created
}

function healthKey(provider: string, model: string): string { return `${provider}\0${model}` }

function mergeHealth(catalog: ModelCatalog, health: ReadonlyMap<string, PersistedModelHealth>): ModelCatalog {
  return {
    ...catalog,
    groups: catalog.groups.map(group => ({
      ...group,
      models: group.models.map((model) => {
        const saved = health.get(healthKey(group.id, model.id))
        if (saved === undefined) return model
        return {
          ...model,
          status: saved.status,
          ...(saved.statusMessage === undefined ? {} : { statusMessage: saved.statusMessage }),
          ...(saved.visionStatus === undefined ? {} : { visionStatus: saved.visionStatus }),
          ...(saved.visionMessage === undefined ? {} : { visionMessage: saved.visionMessage }),
          lastCheckedAt: saved.lastCheckedAt,
        }
      }),
    })),
  }
}

function captureHealth(cache: CatalogCache, catalog: ModelCatalog): void {
  for (const group of catalog.groups) {
    for (const model of group.models) {
      if (model.status === undefined || model.status === 'checking' || model.lastCheckedAt === undefined) continue
      cache.health.set(healthKey(group.id, model.id), {
        status: model.status,
        ...(model.statusMessage === undefined ? {} : { statusMessage: model.statusMessage }),
        ...(model.visionStatus === undefined ? {} : { visionStatus: model.visionStatus }),
        ...(model.visionMessage === undefined ? {} : { visionMessage: model.visionMessage }),
        lastCheckedAt: model.lastCheckedAt,
      })
      if (model.visionStatus === 'supported') cache.visionSupported.add(healthKey(group.id, model.id))
    }
  }
}

async function hydrateHealth(cache: CatalogCache): Promise<void> {
  if (cache.hydration !== undefined) return cache.hydration
  const operation = (async () => {
    const path = modelHealthPath()
    if (path === undefined) return
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as { version?: unknown; models?: unknown }
      if (parsed.version !== 1 || typeof parsed.models !== 'object' || parsed.models === null || Array.isArray(parsed.models)) return
      for (const [key, candidate] of Object.entries(parsed.models)) {
        const value = persistedHealth(candidate)
        if (value === undefined) continue
        cache.health.set(key, value)
        if (value.visionStatus === 'supported') cache.visionSupported.add(key)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return
    }
  })()
  cache.hydration = operation
  await operation
}

function persistedHealth(candidate: unknown): PersistedModelHealth | undefined {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return undefined
  const value = candidate as Record<string, unknown>
  const status = value.status
  const visionStatus = value.visionStatus
  if (status !== 'available' && status !== 'unavailable' && status !== 'requires-login' && status !== 'unknown') return undefined
  if (typeof value.lastCheckedAt !== 'number' || !Number.isFinite(value.lastCheckedAt)) return undefined
  if (visionStatus !== undefined && visionStatus !== 'supported' && visionStatus !== 'unsupported' && visionStatus !== 'unknown') return undefined
  return {
    status,
    ...(typeof value.statusMessage === 'string' ? { statusMessage: value.statusMessage } : {}),
    ...(visionStatus === undefined ? {} : { visionStatus }),
    ...(typeof value.visionMessage === 'string' ? { visionMessage: value.visionMessage } : {}),
    lastCheckedAt: value.lastCheckedAt,
  }
}

async function persistHealth(cache: CatalogCache): Promise<void> {
  const previous = cache.persistTail ?? Promise.resolve()
  const operation = previous.catch(() => {}).then(() => persistHealthNow(cache))
  cache.persistTail = operation
  try {
    await operation
  } finally {
    if (cache.persistTail === operation) delete cache.persistTail
  }
}

async function persistHealthNow(cache: CatalogCache): Promise<void> {
  const path = modelHealthPath()
  if (path === undefined) return
  const temporary = `${path}.${randomUUID()}.tmp`
  const models = Object.fromEntries([...cache.health.entries()].sort(([left], [right]) => left.localeCompare(right)))
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temporary, `${JSON.stringify({ version: 1, models })}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  } catch { /* health persistence must never make a working model probe fail */ }
}

function modelHealthPath(): string | undefined {
  const home = process.env.DSH_HOME?.trim()
  return home === undefined || home === '' ? undefined : join(resolve(home), 'cache', 'model-health-v1.json')
}

async function buildModelCatalogUncached(
  ctx: Context,
  defaultSelection: ModelSelection,
  options: ModelCatalogOptions,
): Promise<ModelCatalog> {
  const providers = ctx.llm.listProviders()
  const catalog = await Promise.all(providers.map(async (provider) => {
    try {
      const models = await ctx.llm.listModels(provider.id)
      const entries = await mapWithConcurrency(models, options.concurrency ?? DEFAULT_PROBE_CONCURRENCY, async model =>
        modelEntry(ctx, provider.id, model, options))
      return { kind: 'group' as const, group: { id: provider.id, name: provider.name, models: entries } }
    } catch (error) {
      return {
        kind: 'failure' as const,
        failure: { id: provider.id, name: provider.name, message: safeMessage(error) },
      }
    }
  }))
  return {
    default: { ...defaultSelection },
    routableProviders: providers.map(provider => provider.id),
    groups: catalog.flatMap(item => item.kind === 'group' ? [item.group] : [])
      .filter(group => group.models.length > 0),
    failures: catalog.flatMap(item => item.kind === 'failure' ? [item.failure] : []),
  }
}

async function checkOneModel(ctx: Context, base: ModelCatalog, options: ModelCatalogOptions): Promise<ModelCatalog> {
  if (options.provider === undefined || options.model === undefined) return base
  let found = false
  const groups = await Promise.all(base.groups.map(async (group) => {
    if (group.id !== options.provider) return group
    const model = group.models.find(candidate => candidate.id === options.model)
    if (model === undefined) return group
    found = true
    const checked = await modelEntry(ctx, group.id, {
      provider: group.id,
      id: model.id,
      name: model.name,
      ...(model.description === undefined ? {} : { description: model.description }),
      ...(model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] }),
    }, { ...options, check: true })
    const entry = model.reasoning === undefined ? checked : { ...checked, reasoning: model.reasoning }
    return { ...group, models: group.models.map(candidate => candidate.id === model.id ? entry : candidate) }
  }))
  return found ? { ...base, groups } : base
}

async function modelEntry(
  ctx: Context,
  provider: string,
  model: LlmModelInfo,
  options: ModelCatalogOptions,
): Promise<ModelCatalogModel> {
  let entry: ModelCatalogModel = {
    id: model.id,
    name: model.name,
    ...(model.description === undefined ? {} : { description: model.description }),
    ...(model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] }),
    ...(model.reasoning === undefined ? {} : { reasoning: {
      efforts: model.reasoning.efforts.map(effort => ({
        id: effort.id,
        name: effort.name,
        ...(effort.description === undefined ? {} : { description: effort.description }),
      })),
      ...(model.reasoning.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort }),
    } }),
  }
  // Adapters now expose local reasoning declarations from listModels(). Keep a
  // compatibility fallback for older adapters whose resolver is synchronous;
  // failures are ignored and never prevent the metadata catalog from loading.
  if (options.check !== true && model.reasoning === undefined) {
    try {
      const resolved = await immediateResolution(ctx, provider, model.id)
      if (resolved.reasoning !== undefined) entry = { ...entry, reasoning: toModelReasoning(resolved.reasoning) }
    } catch { /* metadata-only catalog remains usable without enrichment */ }
    return entry
  }
  // A health check only needs the already declared route. Re-resolving model
  // metadata here serializes every probe behind provider discovery and can
  // make a healthy model appear hung; metadata is refreshed in a separate
  // catalog operation.
  if (options.check !== true) {
    try {
      const resolved = await ctx.llm.resolveModelInfo(provider, model.id)
      const reasoning: ModelReasoning | undefined = resolved.reasoning === undefined ? undefined : toModelReasoning(resolved.reasoning)
      entry = {
        ...entry,
        ...(model.description ?? resolved.description) === undefined
          ? {}
          : { description: model.description ?? resolved.description },
        ...(resolved.inputModalities === undefined ? {} : { inputModalities: [...resolved.inputModalities] }),
        ...(reasoning === undefined ? {} : { reasoning }),
      }
    } catch {
      // A broken metadata lookup must not hide every other model in the group.
    }
  }
  const checkedAt = Date.now()
  let status: ModelAvailability = 'unavailable'
  let statusMessage: string | undefined
  try {
    const attempts = await probeWithTimeout(signal => ctx.llm.probeModel(provider, model.id, signal), options.timeoutMs)
    const successful = attempts.some((attempt: LlmProbeAttempt) => attempt.ok)
    if (successful) status = 'available'
    else {
      const message = attempts.map((attempt: LlmProbeAttempt) => attempt.message).filter(Boolean).join('; ')
      statusMessage = message === '' ? 'model probe failed' : redact(message)
      status = availabilityOfError(new Error(statusMessage))
    }
  } catch (error) {
    statusMessage = redact(safeMessage(error))
    status = availabilityOfError(error)
  }

  const visionKey = healthKey(provider, model.id)
  let visionStatus: ModelVisionStatus = catalogCacheFor(ctx).visionSupported.has(visionKey) ? 'supported' : 'unknown'
  let visionMessage: string | undefined
  try {
    if (visionStatus === 'supported') {
      return {
        ...entry,
        status,
        ...(statusMessage === undefined ? {} : { statusMessage }),
        visionStatus,
        lastCheckedAt: checkedAt,
      }
    }
    const vision = await probeVisionWithTimeout(signal => ctx.llm.probeVision(provider, model.id, signal), options.timeoutMs)
    visionStatus = vision.status
    if (visionStatus === 'supported') catalogCacheFor(ctx).visionSupported.add(visionKey)
    visionMessage = vision.message === undefined ? undefined : redact(vision.message)
  } catch (error) {
    visionMessage = redact(safeMessage(error))
  }
  return {
    ...entry,
    status,
    ...(statusMessage === undefined ? {} : { statusMessage }),
    visionStatus,
    ...(visionMessage === undefined ? {} : { visionMessage }),
    lastCheckedAt: checkedAt,
  }
}

/** Accept only resolver results already available in the current microtask. */
async function immediateResolution(
  ctx: Context,
  provider: string,
  model: string,
): Promise<import('@deepseek-ai/dsh-llm').LlmResolvedModelInfo> {
  const resolution = ctx.llm.resolveModelInfo(provider, model)
  const deferred = new Promise<undefined>(resolve => setTimeout(() => { resolve(undefined) }, 0))
  const resolved = await Promise.race([resolution, deferred])
  if (resolved === undefined) throw new Error('metadata resolution deferred')
  return resolved
}

function toModelReasoning(reasoning: NonNullable<import('@deepseek-ai/dsh-llm').LlmResolvedModelInfo['reasoning']>): ModelReasoning {
  return {
    efforts: reasoning.efforts.map(effort => ({
      id: effort.id,
      name: effort.name,
      ...(effort.description === undefined ? {} : { description: effort.description }),
    })),
    ...(reasoning.defaultEffort === undefined ? {} : { defaultEffort: reasoning.defaultEffort }),
  }
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      const item = items[index]
      if (item === undefined) return
      results[index] = await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()))
  return results
}

async function probeWithTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const request = operation(controller.signal)
    return await Promise.race([
      request,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error(`probe timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function probeVisionWithTimeout(
  operation: (signal: AbortSignal) => Promise<LlmVisionProbeResult>,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<LlmVisionProbeResult> {
  return probeWithTimeout(operation, timeoutMs)
}

function availabilityOfError(error: unknown): ModelAvailability {
  const message = safeMessage(error).toLowerCase()
  return /login|log in|unauthor|credential|api key|authentication|\b401\b|\b403\b/.test(message)
    ? 'requires-login'
    : 'unavailable'
}

function safeMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return String(error)
}

/** Do not send credentials or long bearer fragments to the browser catalog. */
function redact(message: string): string {
  return message
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/(api[_ -]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 240)
}
