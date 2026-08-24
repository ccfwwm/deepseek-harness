/** Read-only projection of the current Cordis Loader plugin entries. */

import type { Context, FiberState } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
// Type-only: the optional agent-preset roster resolved through `ctx.get`.
import type {} from '@deepseek-ai/dsh-agent-presets'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import type {
  AgentPresetPluginGroup,
  PluginEntryId,
  PluginFiberPhase,
  PluginInventoryEntry,
  PluginInventorySnapshot,
  PluginInstallRequest,
  PluginInstallTask,
} from './types.ts'

export type * from './types.ts'

/** Brand an existing Loader-tree entry id at the owning boundary. */
function pluginEntryId(value: string): PluginEntryId {
  return value as PluginEntryId
}

/** Runtime mirror: FiberState is a cross-package const enum. */
const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const

/** Complete public projection of Cordis Fiber states. */
const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
} as const satisfies Record<FiberState, PluginFiberPhase>

/** Remote-only service exposing the Loader's current non-group entry state. */
export class PluginInventoryGateway extends TypertRemoteService {
  static inject = ['loader']
  private readonly tasks = new Map<string, PluginInstallTask>()

  constructor(ctx: Context) {
    super(ctx, 'pluginInventory')
  }

  /**
   * Read the Loader directly on every call. Cordis's internal plugin/status
   * events already maintain Entry.fiber and Fiber.state, so a second cache
   * would only add another lifecycle truth to keep synchronized.
   *
   * When an agent-preset roster is composed, the snapshot also carries each
   * preset's composition rows, because those rows — not the Loader's own
   * entries — are where a deployment that mounts the roster runs its
   * model-facing plugins.
   * @returns Current non-group Loader entries in Loader order, with per-preset
   * compositions when a roster is composed.
   */
  @Remote('list')
  async list(): Promise<PluginInventorySnapshot> {
    const entries: PluginInventoryEntry[] = []
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.group) continue
      entries.push({
        entryId: pluginEntryId(entry.id),
        moduleName: entry.options.name,
        enabled: !entry.disabled,
        canDisable: isUserControllable(entry.options.name),
        fiberPhase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state],
      })
    }
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return { entries }
    const agentPresets: AgentPresetPluginGroup[] = (await presets.compositionInventory()).map(
      composition => ({
        ...composition,
        rows: composition.rows.map(({ fiberState, ...row }) => ({
          ...row,
          fiberPhase: fiberState === undefined ? null : FIBER_PHASE[fiberState],
        })),
      }),
    )
    return { entries, agentPresets }
  }

  @Remote('setEnabled')
  async setEnabled(entryId: PluginEntryId, enabled: boolean): Promise<PluginInventorySnapshot> {
    const entry = [...this.ctx.loader.entries()].find(item => item.id === entryId)
    if (entry === undefined) throw new Error(`Plugin entry "${entryId}" was not found.`)
    if (!isUserControllable(entry.options.name)) throw new Error(`Plugin "${entry.options.name}" is required by ZeroWall and cannot be disabled.`)
    await this.ctx.loader.update(entryId, { disabled: !enabled })
    return this.list()
  }

  @Remote('listTasks')
  listTasks(): readonly PluginInstallTask[] { return [...this.tasks.values()] }

  @Remote('add')
  add(request: PluginInstallRequest): PluginInstallTask {
    const specifier = request.specifier.trim()
    if (specifier.length === 0 || /[\r\n\0]/u.test(specifier)) throw new Error('Plugin specifier is invalid.')
    const id = `plugin-install-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const command = ['dsh', 'plugin', '--profile', this.profileName(), 'add', specifier]
    const task: PluginInstallTask = { id, specifier, command, status: 'queued', logs: [`$ ${command.join(' ')}`], startedAt: Date.now() }
    this.tasks.set(id, task)
    void this.runInstall(task)
    return task
  }

  @Remote('getTask')
  getTask(id: string): PluginInstallTask | undefined { return this.tasks.get(id) }

  private profileName(): string {
    const compat = this.ctx.get('zerowallDesktopCompat') as { currentProfile?: { name: string } } | undefined
    return compat?.currentProfile?.name ?? 'stable'
  }

  private async runInstall(task: PluginInstallTask): Promise<void> {
    const compat = this.ctx.get('zerowallDesktopCompat') as { install: (specifier: string, invokingDir: string) => { stdout: AsyncIterable<Buffer | string>; stderr: AsyncIterable<Buffer | string>; done: Promise<{ exitCode: number | null }>; } } | undefined
    if (compat === undefined) {
      this.tasks.set(task.id, { ...task, status: 'failed', finishedAt: Date.now(), error: 'Plugin installation is only available in the ZeroWall desktop runtime.', logs: [...task.logs, 'Desktop plugin service is unavailable.'] })
      return
    }
    try {
      const handle = compat.install(task.specifier, process.cwd())
      this.tasks.set(task.id, { ...task, status: 'running' })
      const logs = [...task.logs]
      const pump = async (stream: AsyncIterable<Buffer | string>, label: string) => { for await (const chunk of stream) logs.push(`[${label}] ${String(chunk).trimEnd()}`) }
      await Promise.all([pump(handle.stdout, 'stdout'), pump(handle.stderr, 'stderr')])
      const result = await handle.done
      const succeeded = result.exitCode === 0
      this.tasks.set(task.id, { ...task, status: succeeded ? 'succeeded' : 'failed', logs: succeeded ? [...logs, 'Plugin installed. Restarting the ZeroWall runtime to activate it.'] : logs, finishedAt: Date.now(), exitCode: result.exitCode })
      if (succeeded && typeof process.send === 'function') process.send({ type: 'zerowall:desktop:restart-runtime' })
    } catch (error) {
      this.tasks.set(task.id, { ...task, status: 'failed', finishedAt: Date.now(), error: error instanceof Error ? error.message : String(error), logs: [...task.logs] })
    }
  }
}

function isUserControllable(moduleName: string): boolean {
  return !moduleName.startsWith('@deepseek-ai/dsh-')
    && !moduleName.includes('cordis-plugin-')
    && !moduleName.includes('plugin-loader')
}

export default PluginInventoryGateway
