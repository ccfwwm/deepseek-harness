import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import { describe, expect, it, vi } from 'vitest'
import { createSessionTestController, testSessionPersistence } from './test-remote.ts'

describe('Session Controller deletion transaction', () => {
  it('reserves, aborts, then forgets only a moved Session and keeps the Host serving lists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'))
    const sessionId = SessionId('target-session')
    const otherId = SessionId('other-session')
    const target = join(root, 'sessions', 'project', sessionId)
    const other = join(root, 'sessions', 'project', otherId)
    const recycle = join(root, 'recycle')
    for (const path of [target, other]) {
      await mkdir(path, { recursive: true })
      await writeFile(join(path, 'session.v5.jsonl'), 'stored')
    }
    const headers: SessionHeader[] = [sessionId, otherId].map(id => ({
      id, version: SESSION_FORMAT_VERSION, createdAt: 1, cwd: root, isSeeded: false,
    }))
    const existing = new Set([sessionId, otherId])
    const forgotten = vi.fn(async (_id: typeof sessionId) => {})
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
        stat: async (id: typeof sessionId) => {
          const header = existing.has(id) ? headers.find(item => item.id === id) : undefined
          return header === undefined ? undefined
            : { header, revision: SessionPersistenceRevision(`test-${id}`) }
        },
        list: async () => headers.filter(header => existing.has(header.id)),
        directory: async (id: typeof sessionId) => id === sessionId ? target : other,
      }) as never)
      ctx.provide('workspaceRegistry', { forgetRemovedSession: forgotten, list: () => [] } as never)
      const controller = createSessionTestController(ctx, {
        defaultModelSelection: () => ({ provider: 'fixture', model: 'model' }), cwd: root,
      })
      await ctx.fiber.await()
      const removed = vi.fn()
      ctx.on('api-session/removed', removed)
      expect((await controller.list({}, new AbortController().signal)).items.map(item => item.sessionId))
        .toEqual(expect.arrayContaining([sessionId, otherId]))

      const first = await controller.prepareDelete({ sessionId })
      expect(first.path).toBe(target)
      await expect(controller.prepareDelete({ sessionId })).rejects.toThrow('being deleted')
      await controller.abortDelete({ sessionId, token: first.token })
      const prepared = await controller.prepareDelete({ sessionId })
      await rename(target, recycle)
      existing.delete(sessionId)
      await expect(controller.commitDelete({ sessionId, token: 'wrong' })).rejects.toThrow('Invalid')
      await expect(controller.commitDelete({ sessionId, token: prepared.token })).resolves.toEqual({ completed: true })
      expect(forgotten).toHaveBeenCalledExactlyOnceWith(sessionId)
      expect(removed).toHaveBeenCalledExactlyOnceWith(sessionId)
      expect((await controller.list({}, new AbortController().signal)).items.map(item => item.sessionId))
        .toEqual([otherId])
      await expect(controller.commitDelete({ sessionId, token: prepared.token })).resolves.toEqual({ completed: true })
      expect((await controller.list({}, new AbortController().signal)).items.map(item => item.sessionId))
        .toEqual([otherId])
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
