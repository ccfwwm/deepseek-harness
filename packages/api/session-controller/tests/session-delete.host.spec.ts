import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionTestController } from './test-remote.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup() {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const stored = new Map<string, object>()
  ctx.provide('sessionPersistence', {
    list: async () => [], inspect: async () => undefined,
    stat: async (id: string) => stored.get(id),
    resolveStoredDirectory: async (id: string) => stored.has(id) ? `/sessions/${id}` : undefined,
  } as never)
  const released: string[] = []
  ctx.agents.setFactory({
    createAgent: async (owner: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
      const session = ctx.sessions.prepare(options.sessionId, { ...options.meta === undefined ? {} : { meta: options.meta } })
      const detach = ctx.sessions.enter(session)
      ctx.sessions.announce(session)
      const agent = { id: session.id, session, status: 'idle', ctx: owner } as Agent
      const unregister = ctx.agents.register(agent)
      stored.set(session.id, {})
      return { agent, dispose: async () => { released.push(session.id); unregister(); detach() } }
    },
    resume: async () => { throw new Error('unexpected resume') },
  })
  const controller = createSessionTestController(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
  return { ctx, controller, stored, released }
}
describe('single-session deletion', () => {
  it('releases only the target, locks admission, publishes after trash, and accepts commit retries', async () => {
    const { ctx, controller, stored, released } = await setup()
    const target = SessionId('delete-target'), other = SessionId('running-other')
    await controller.create({ sessionId: target })
    await controller.create({ sessionId: other })
    Object.assign(ctx.agents.get(other)!, { status: 'running' })
    const removed = vi.fn(); ctx.on('api-session/removed', removed)
    const prepared = await controller.prepareDelete({ sessionId: target })
    expect(prepared.path).toBe('/sessions/delete-target')
    expect(released).toEqual([target]); expect(removed).not.toHaveBeenCalled()
    expect(ctx.agents.get(other)?.status).toBe('running')
    expect(() => controller.create({ sessionId: target })).toThrow(/deletion/)
    await expect(controller.commitDelete({ sessionId: target, token: prepared.token })).rejects.toThrow(/still exists/)
    stored.delete(target)
    await controller.commitDelete({ sessionId: target, token: prepared.token })
    await controller.commitDelete({ sessionId: target, token: prepared.token })
    expect(removed).toHaveBeenCalledTimes(1)
  })
  it('rejects a running target without disposal and unlocks after a failed prepare', async () => {
    const { ctx, controller, released } = await setup()
    const target = SessionId('busy-target')
    await controller.create({ sessionId: target })
    Object.assign(ctx.agents.get(target)!, { status: 'running' })
    await expect(controller.prepareDelete({ sessionId: target })).rejects.toThrow(/finish/)
    expect(released).toEqual([])
    Object.assign(ctx.agents.get(target)!, { status: 'idle' })
    const prepared = await controller.prepareDelete({ sessionId: target })
    await controller.abortDelete({ sessionId: target, token: prepared.token })
    // The durable record can be accessed again; no whole-host replacement occurs.
    expect(() => controller.follow({ address: { kind: 'session', sessionId: target } }, new AbortController().signal)).not.toThrow()
  })
  it('prepares cold storage without creating an agent and rejects wrong capabilities', async () => {
    const { controller, stored, released } = await setup()
    const target = SessionId('cold-target'); stored.set(target, {})
    const prepared = await controller.prepareDelete({ sessionId: target })
    expect(released).toEqual([])
    await expect(controller.abortDelete({ sessionId: target, token: 'wrong' })).rejects.toThrow(/mismatched/)
    await controller.abortDelete({ sessionId: target, token: prepared.token })
    expect((await controller.prepareDelete({ sessionId: target })).token).not.toBe(prepared.token)
  })
})
