import { expect, it } from 'vitest'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap { 'test/informational': { state: string } }
}

it('preserves an explicit informational marker through append, serialization and restore', () => {
  const session = Session.create(SessionId('informational-writer'))
  const event = session.append('test/informational', { state: 'kept' }, { ignorable: true })
  expect(event.ignorable).toBe(true)
  expect(Object.isFrozen(event)).toBe(true)
  const restored = Session.create(SessionId('informational-restored'), JSON.parse(JSON.stringify(session.snapshotEvents())))
  expect(restored.snapshotEvents()[0]).toEqual(event)
  expect(restored.deriveMessages()).toEqual([])
})

it('keeps the default required and rejects invalid explicit markers before append', () => {
  const session = Session.create(SessionId('informational-invalid'))
  const append = session.append.bind(session) as (type: 'test/informational', data: { state: string }, opts: unknown) => SessionEvent
  expect(() => append('test/informational', { state: 'kept' }, { ignorable: false })).toThrow('marker must be true')
  expect(session.seq).toBe(0)
  expect(session.append('test/informational', { state: 'required' }).ignorable).toBeUndefined()
})
