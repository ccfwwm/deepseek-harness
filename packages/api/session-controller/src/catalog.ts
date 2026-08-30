/** Shared projection of the live LLM registry into the browser model catalog. */

import type { Context } from '@deepseek-ai/cordis'
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
const DEFAULT_PROBE_TIMEOUT_MS = 20_000
const DEFAULT_PROBE_CONCURRENCY = 3

interface CatalogCache {
  value?: ModelCatalog
  checked: boolean
  metadataInflight?: Promise<ModelCatalog> | undefined
  checkInflight?: Promise<ModelCatalog> | undefined
}

const catalogCaches = new WeakMap<object, CatalogCache>()

/** Build the browser model catalog without requiring a Session. */
export async function buildModelCatalog(
  ctx: Context,
  defaultSelection: ModelSelection = ctx.agentDefaultModel.currentSelection(),
  options: ModelCatalogOptions = {},
): Promise<ModelCatalog> {
  const cache = catalogCacheFor(ctx)
  const targeted = options.provider !== undefined || options.model !== undefined
  if (options.check !== true) {
    if (cache.value !== undefined) return cache.value
    if (cache.checkInflight !== undefined) return cache.checkInflight
    if (cache.metadataInflight !== undefined) return cache.metadataInflight
    const operation = buildModelCatalogUncached(ctx, defaultSelection, {})
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
  if (!targeted && options.refresh !== true && cache.checkInflight !== undefined) return cache.checkInflight
  if (targeted) {
    const base = cache.value ?? await buildModelCatalog(ctx, defaultSelection, {})
    const value = await checkOneModel(ctx, base, options)
    cache.value = value
    // A targeted probe only establishes one row. Keep the generation marked
    // as partially checked so the next startup/explicit all-model check still
    // probes every remaining model instead of treating unknown rows as fresh.
    return value
  }
  const operation = buildModelCatalogUncached(ctx, defaultSelection, options)
  if (options.refresh !== true) cache.checkInflight = operation
  try {
    const value = await operation
    cache.value = value
    cache.checked = true
    return value
  } finally {
    if (cache.checkInflight === operation) cache.checkInflight = undefined
  }
}

/** Drop the cached catalog when a provider/settings generation changes. */
export function invalidateModelCatalog(ctx: Context): void {
  catalogCaches.delete(ctx)
}

function catalogCacheFor(ctx: Context): CatalogCache {
  const key = ctx as object
  const existing = catalogCaches.get(key)
  if (existing !== undefined) return existing
  const created: CatalogCache = { checked: false }
  catalogCaches.set(key, created)
  return created
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
    const entry = await modelEntry(ctx, group.id, {
      provider: group.id,
      id: model.id,
      name: model.name,
      ...(model.description === undefined ? {} : { description: model.description }),
      ...(model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] }),
    }, { ...options, check: true })
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
  }
  try {
    const resolved = await ctx.llm.resolveModelInfo(provider, model.id)
    const reasoning: ModelReasoning | undefined = resolved.reasoning === undefined
      ? undefined
      : {
        efforts: resolved.reasoning.efforts.map(effort => ({
          id: effort.id,
          name: effort.name,
          ...(effort.description === undefined ? {} : { description: effort.description }),
        })),
        ...(resolved.reasoning.defaultEffort === undefined ? {} : { defaultEffort: resolved.reasoning.defaultEffort }),
      }
    entry = {
      ...entry,
      ...(model.description ?? resolved.description) === undefined
        ? {}
        : { description: model.description ?? resolved.description },
      ...(resolved.inputModalities === undefined ? {} : { inputModalities: [...resolved.inputModalities] }),
      ...(reasoning === undefined ? {} : { reasoning }),
    }
  } catch (error) {
    // A broken metadata lookup must not hide every other model in the group.
    if (options.check === true) entry = { ...entry, status: availabilityOfError(error), statusMessage: redact(safeMessage(error)) }
  }
  if (options.check !== true) return entry

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

  let visionStatus: ModelVisionStatus = 'unknown'
  let visionMessage: string | undefined
  try {
    const vision = await probeVisionWithTimeout(signal => ctx.llm.probeVision(provider, model.id, signal), options.timeoutMs)
    visionStatus = vision.status
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
