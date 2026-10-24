import { Context, Service } from '@deepseek-ai/cordis'
import { Entry, type EntryOptions } from './entry.ts'
import { EntryTree } from './tree.ts'

/** Runtime owner for a list of child loader entries. */
export class EntryGroup {
  static readonly key = Symbol.for('cordis.group')

  public data: EntryOptions[] = []

  constructor(public ctx: Context, public tree: EntryTree) {
    const entry = ctx.fiber.entry
    if (entry) entry.subgroup = this
  }

  get context(): Context {
    return this.ctx
  }

  async create(options: Omit<EntryOptions, 'id'>) {
    const id = this.tree.ensureId(options)
    const entry: Entry = this.tree.store[id] ??= new Entry(this.ctx.loader)
    // Entry may be moved from another group,
    // so we need to update the parent reference.
    entry.parent = this
    // Use `create: true` to replace existing entry.options.
    await entry.update(options, true, true)
    return entry.id
  }

  unlink(options: EntryOptions) {
    const config = this.data
    const index = config.indexOf(options)
    if (index >= 0) config.splice(index, 1)
  }

  remove(id: string, isDispose = false) {
    const entry = this.tree.store[id]
    if (!entry) return
    entry.fiber?.dispose()
    if (!isDispose) {
      this.unlink(entry.options)
    }
    delete this.tree.store[id]
    this.context.emit('loader/partial-dispose', entry, entry.options, false)
  }

  async update(config: EntryOptions[]) {
    const oldConfig = this.data as EntryOptions[]
    this.data = config
    const oldMap = Object.fromEntries(oldConfig.map(options => [options.id, options]))
    const newMap = Object.fromEntries(config.map(options => [options.id ?? Symbol('anonymous'), options]))

    // update inner plugins
    const ids = Reflect.ownKeys({ ...oldMap, ...newMap }) as string[]
    const startupRequired = this.ctx.loader.startupRequiredIds
    const containsRequired = (options: EntryOptions): boolean => {
      if (options.name === 'cordis:include') return true
      if (startupRequired?.has(options.id)) return true
      if (!options.group || !Array.isArray(options.config)) return false
      return options.config.some(containsRequired)
    }
    const updates = ids.map(async (id) => {
      if (newMap[id]) {
        const createdId = await this.create(newMap[id]).catch((error) => {
          this.ctx.logger.error(error)
          return undefined
        })
        if (startupRequired && createdId !== undefined && containsRequired(newMap[id])) {
          const entry = this.tree.store[id] ?? this.tree.resolve(createdId)
          if (entry?._initTask) await entry._initTask
          // Tree carriers (Group/Include) create their child rows from their
          // own service init. Waiting for the carrier fiber here would also
          // wait for every optional descendant and defeat selective startup.
          // The app-boot readiness pass observes the carrier's subtree and
          // awaits only the required descendants after they materialize.
          if (entry?.subtree) {
            const startupReady = (entry.subtree as EntryTree & { startupReady?: Promise<void> }).startupReady
            if (startupReady) await startupReady
          } else if (entry && !entry.subgroup && entry.fiber) {
            await entry.fiber.await()
          }
        }
      } else {
        this.remove(id)
      }
    })
    if (!startupRequired) {
      await Promise.all(updates)
      return
    }

    // Start every row promptly, but let startup wait only for rows that are
    // required themselves or contain a required descendant. Detached rows
    // still report import/config/lifecycle failures through their normal
    // Loader diagnostics and are included in later explicit Loader.await().
    const pending = ids.flatMap((id, index) => newMap[id] && containsRequired(newMap[id])
      ? [updates[index]]
      : [])
    void Promise.all(updates.filter((_, index) => !pending.includes(updates[index])))
      .catch((error) => this.ctx.logger.error(error))
    await Promise.all(pending)
  }

  stop() {
    for (const options of this.data) {
      this.remove(options.id, true)
    }
  }
}

/** Plugin that mounts a nested loader entry group. */
export class Group extends EntryGroup {
  static initial: Omit<EntryOptions, 'id'>[] = []
  static readonly [EntryGroup.key] = true

  constructor(public ctx: Context, public config: EntryOptions[]) {
    super(ctx, ctx.fiber.entry!.parent.tree)
    ctx.on('internal/update', (config) => {
      this.update(config)
    })
  }

  async* [Service.init]() {
    yield () => this.stop()
    await this.update(this.config)
  }
}
