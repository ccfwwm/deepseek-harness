import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { describe, expect, it, vi } from 'vitest'
import { ModelCatalogDirectory } from '../src/client/catalog.ts'

const catalog = (model: string): ModelCatalog => ({
  default: { provider: 'fixture', model },
  routableProviders: ['fixture'],
  groups: [{ id: 'fixture', name: 'Fixture', models: [{ id: model, name: model }] }],
  failures: [],
})

function directory(models: () => Promise<unknown>): ModelCatalogDirectory {
  // The providing plugin's context, scripted down to the one method it calls.
  return new ModelCatalogDirectory({ remote: { session: { modelCatalog: models } } } as never)
}

describe('ModelCatalogDirectory', () => {
  it('checks routes incrementally without clearing the last known rows', async () => {
    const initial = catalog('one')
    const completedCatalog: ModelCatalog = {
      ...initial,
      groups: [{ ...initial.groups[0]!, models: [{ id: 'one', name: 'one', status: 'available' }] }],
    }
    const completed = Promise.withResolvers<unknown>()
    const models = vi.fn((request?: { check?: boolean }) => {
      if (request?.check === true) return completed.promise
      if (models.mock.calls.length === 1) return Promise.resolve({ ok: true, value: initial })
      return Promise.resolve({ ok: true, value: completedCatalog })
    })
    const subject = directory(models)
    await subject.load()

    const check = subject.checkAll()
    await Promise.resolve()
    expect(models.mock.calls.filter(([request]) => request?.check === true)).toHaveLength(1)
    expect(subject.store.getSnapshot().value).toEqual(initial)
    expect(models).toHaveBeenCalledTimes(2)
    expect(models).toHaveBeenLastCalledWith({ check: true, refresh: true, provider: 'fixture', model: 'one' })
    completed.resolve({ ok: true, value: completedCatalog })
    await expect(check).resolves.toEqual(completedCatalog)
    expect(subject.store.getSnapshot().value).toEqual(completedCatalog)
  })

  it('coalesces concurrent startup checks into one incremental route probe', async () => {
    const initial = catalog('one')
    const completed = Promise.withResolvers<unknown>()
    const models = vi.fn((request?: { check?: boolean; background?: boolean }) => request?.check === true
      ? completed.promise
      : Promise.resolve({ ok: true, value: initial }))
    const subject = directory(models)
    await subject.load()

    const first = subject.checkAll(true)
    const second = subject.checkAll(true)
    expect(second).toBe(first)
    await Promise.resolve()
    expect(models.mock.calls.filter(([request]) => request?.check === true)).toEqual([[
      { check: true, refresh: true, provider: 'fixture', model: 'one' },
    ]])

    completed.resolve({ ok: true, value: initial })
    await expect(first).resolves.toEqual(initial)
  })

  it('keeps the shared catalog ready while one model is being checked', async () => {
    const initial: ModelCatalog = {
      default: { provider: 'fixture', model: 'one' },
      routableProviders: ['fixture'],
      groups: [{ id: 'fixture', name: 'Fixture', models: [
        { id: 'one', name: 'one', status: 'available' },
        { id: 'two', name: 'two', status: 'unavailable' },
      ] }],
      failures: [],
    }
    const checked: ModelCatalog = {
      ...initial,
      groups: [{ ...initial.groups[0]!, models: [
        initial.groups[0]!.models[0]!,
        { id: 'two', name: 'two', status: 'available', lastCheckedAt: 1 },
      ] }],
    }
    const pending = Promise.withResolvers<unknown>()
    const models = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: initial })
      .mockReturnValueOnce(pending.promise)
    const subject = directory(models)
    await subject.load()

    const check = subject.checkModel('fixture', 'two')
    expect(subject.store.getSnapshot()).toMatchObject({ status: 'ready', error: null })
    expect(subject.store.getSnapshot().value?.groups[0]?.models[1]?.status).toBe('checking')
    pending.resolve({ ok: true, value: checked })
    await expect(check).resolves.toEqual(checked)
    expect(subject.store.getSnapshot()).toMatchObject({ value: checked, status: 'ready', error: null })
  })

  it('shares one failing request, exposes the RPC error, and permits a retry', async () => {
    const models = vi.fn()
      .mockResolvedValueOnce({
        ok: false, error: new RemoteError('gateway/internal', 'catalog offline', {}),
      })
      .mockResolvedValueOnce({ ok: true, value: catalog('recovered') })
    const subject = directory(models)

    const first = subject.load()
    expect(subject.load()).toBe(first)
    await expect(first).rejects.toThrow('gateway/internal: catalog offline')
    expect(subject.store.getSnapshot()).toMatchObject({ status: 'error', error: 'gateway/internal: catalog offline' })
    await expect(subject.load()).resolves.toEqual(catalog('recovered'))
    expect(models).toHaveBeenCalledTimes(2)
  })

  it('does not publish a successful result from an invalidated generation', async () => {
    const first = Promise.withResolvers<unknown>()
    const second = Promise.withResolvers<unknown>()
    const models = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const subject = directory(models)

    const stale = subject.load()
    subject.resetGeneration()
    first.resolve({ ok: true, value: catalog('stale') })
    await expect(stale).resolves.toEqual(catalog('stale'))
    expect(subject.store.getSnapshot()).toMatchObject({ value: null, status: 'loading' })
    second.resolve({ ok: true, value: catalog('fresh') })
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toMatchObject({ value: catalog('fresh'), status: 'ready' })
    })
  })

  it('does not publish a failure from an invalidated generation', async () => {
    const first = Promise.withResolvers<unknown>()
    const second = Promise.withResolvers<unknown>()
    const models = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const subject = directory(models)

    const stale = subject.load()
    subject.resetGeneration()
    first.reject(new Error('stale failure'))
    await expect(stale).rejects.toThrow('stale failure')
    expect(subject.store.getSnapshot()).toMatchObject({ value: null, status: 'loading', error: null })
    second.resolve({ ok: true, value: catalog('fresh') })
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toMatchObject({ value: catalog('fresh'), status: 'ready' })
    })
  })

  it('contains refresh failures while retaining old data and clears it on a failed Host reset', async () => {
    const models = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: catalog('old') })
      .mockRejectedValueOnce('refresh failed')
      .mockRejectedValueOnce(new Error('reset failed'))
    const subject = directory(models)
    await subject.load()

    subject.refresh()
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toEqual({
        value: catalog('old'), status: 'error', error: 'refresh failed',
      })
    })

    subject.resetGeneration()
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toEqual({
        value: null, status: 'error', error: 'reset failed',
      })
    })
  })
})
