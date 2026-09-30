/** Real HTTP Remote coverage for the desktop's three-step Session deletion. */
import { randomUUID } from 'node:crypto'
import { lstat, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

async function remote<T>(scaffold: WebScaffold, method: string, request: unknown): Promise<T> {
  const response = await scaffold.hostFetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request', rpcId: randomUUID(), method,
      payload: { args: { [method === 'session/list' ? '_request' : 'request']: request } },
    }),
  })
  expect(response.status, `${method} must have a registered HTTP route`).toBe(200)
  const body = await response.json() as { result: RpcResult<T> }
  if (!body.result.ok) throw new Error(`${method}: ${body.result.error.code}: ${body.result.error.message}`)
  return body.result.value
}

describe('web e2e: Session deletion HTTP transaction', () => {
  let scaffold: WebScaffold

  beforeAll(async () => { scaffold = await launchWebScaffold({ profile: { packages: [] } }) }, 120_000)
  afterAll(async () => { await scaffold?.close() })

  it('aborts, then commits one trashed Session while the Host and neighbour stay live', async () => {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const target = SessionId((await remote<{ sessionId: string }>(scaffold, 'session/create', {
      workspaceId: workspace.id,
    })).sessionId)
    const other = SessionId((await remote<{ sessionId: string }>(scaffold, 'session/create', {
      workspaceId: workspace.id,
    })).sessionId)
    const list = async () => (await remote<{ items: { sessionId: string }[] }>(scaffold, 'session/list', {}))
      .items.map(item => item.sessionId)
    expect(await list()).toEqual(expect.arrayContaining([target, other]))
    expect(workspace.sessionIds).toEqual(expect.arrayContaining([target, other]))
    expect(scaffold.ctx.agents.get(target)).toBeDefined()
    expect(scaffold.ctx.agents.get(other)).toBeDefined()

    const first = await remote<{ token: string; path: string }>(scaffold, 'session/prepareDelete', { sessionId: target })
    expect(first.path).toBe(await scaffold.ctx.sessionPersistence.directory(target))
    expect(scaffold.ctx.agents.get(target)).toBeUndefined()
    await remote<{ completed: true }>(scaffold, 'session/abortDelete', { sessionId: target, token: first.token })
    expect(await list()).toContain(target)

    const prepared = await remote<{ token: string; path: string }>(scaffold, 'session/prepareDelete', { sessionId: target })
    const trashed = join(scaffold.workspaceCwd, `trashed-${target}`)
    await rename(prepared.path, trashed)
    expect((await lstat(trashed)).isDirectory()).toBe(true)
    await remote<{ completed: true }>(scaffold, 'session/commitDelete', { sessionId: target, token: prepared.token })
    expect(await list()).not.toContain(target)
    expect(await list()).toContain(other)
    expect(await scaffold.ctx.sessionPersistence.stat(target)).toBeUndefined()
    expect(await scaffold.ctx.sessionPersistence.stat(other)).toBeDefined()
    expect(workspace.sessionIds).toEqual([other])
    expect(scaffold.ctx.agents.get(other)).toBeDefined()
    await remote<{ completed: true }>(scaffold, 'session/commitDelete', { sessionId: target, token: prepared.token })
    expect(await list()).toContain(other)
  }, 120_000)
})
