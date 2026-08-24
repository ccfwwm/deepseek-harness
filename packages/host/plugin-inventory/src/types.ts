import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable Loader-tree identity of one configured plugin entry. */
export type PluginEntryId = Branded<'PluginEntryId'>

/** Lifecycle state of an entry's root Fiber, or null when it has no live root Fiber. */
export type PluginFiberPhase =
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'unloading'
  | null

/** One non-group Loader entry exposed to trusted clients. */
export interface PluginInventoryEntry {
  readonly entryId: PluginEntryId
  /** Exact module specifier imported by the Loader entry. */
  readonly moduleName: string
  /** Effective Loader enablement, including disabled ancestor groups. */
  readonly enabled: boolean
  /** System/runtime entries are always active and cannot be changed from Settings. */
  readonly canDisable: boolean
  readonly fiberPhase: PluginFiberPhase
}

/** Point-in-time inventory returned by the plugin inventory Remote. */
export interface PluginInventorySnapshot {
  readonly entries: readonly PluginInventoryEntry[]
}

export type PluginInstallStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface PluginInstallTask {
  readonly id: string
  readonly specifier: string
  readonly command: readonly string[]
  readonly status: PluginInstallStatus
  readonly logs: readonly string[]
  readonly startedAt: number
  readonly finishedAt?: number
  readonly exitCode?: number | null
  readonly error?: string
}

export interface PluginInstallRequest {
  readonly specifier: string
}
