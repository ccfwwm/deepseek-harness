import { describe, expect, it } from 'vitest'
import { assertReleasedEventPayload } from '../src/validation.ts'

describe('released ZeroWall extension records', () => {
  it('preserves capability selections and retired review switches', () => {
    for (const [type, data] of [
      ['zerowall/capabilities/selection', { tools: ['read'], disabled: [], onDemand: ['python'] }],
      ['autoReview/state', { enabled: true }],
    ] as const) {
      const event = { type, data, seq: 0, time: 1, ignorable: true as const }
      expect(() => assertReleasedEventPayload(event, 0)).not.toThrow()
    }
  })
  it('retains the legacy file-review marker but rejects unrelated text fields', () => {
    const marker = { schema: 1, files: [{ path: 'report.md' }] }
    const event = { type: 'user/message', seq: 0, time: 1, data: { id: 'message', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '', dshFileReview: marker }] } }
    expect(() => assertReleasedEventPayload(event, 0)).not.toThrow()
    expect(event.data.content[0]?.dshFileReview).toBe(marker)
    const invalid = structuredClone(event)
    Object.assign(invalid.data.content[0]!, { arbitrary: true })
    expect(() => assertReleasedEventPayload(invalid, 0)).toThrow('unexpected member')
  })
})
