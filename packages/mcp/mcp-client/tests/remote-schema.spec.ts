import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { publicToolName, syncTools } from '../src/tools.ts'
import { describe, expect, it } from 'vitest'

describe.runIf(Boolean(process.env.R_PLATFORM_MCP_AUTHORIZATION && process.env.R_PLATFORM_MCP_URL))('remote MCP model schemas', () => {
  it('keeps every remote argument after registration and emits object-root function parameters', async () => {
    const ctx = new Context()
    const client = new Client({ name: 'zerowall-schema-check', version: '5.3.0' })
    const key = process.env.R_PLATFORM_MCP_AUTHORIZATION!.trim()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await client.connect(new StreamableHTTPClientTransport(new URL(process.env.R_PLATFORM_MCP_URL!), {
        requestInit: { headers: { Authorization: /^Bearer\s/iu.test(key) ? key : `Bearer ${key}` } },
      }) as Transport)
      const raw = []
      let cursor: string | undefined
      do {
        const page = await client.listTools({ cursor })
        raw.push(...page.tools)
        cursor = page.nextCursor
      } while (cursor)
      await syncTools(client, ctx, { serverName: 'rmcp', toolCallTimeoutMs: 30_000, registrationFailure: 'throw' }, new Map())
      const schemas = ctx.tools.schemas()
      expect(schemas).toHaveLength(raw.length)
      // Compare the source contract with the actual JSON sent to a model provider.
      const parameters = JSON.parse(JSON.stringify(Object.fromEntries(
        schemas.map(tool => [tool.name, tool.parameters]),
      ))) as Record<string, Record<string, unknown>>
      for (const tool of raw) {
        const registered = parameters[publicToolName('rmcp', tool.name)]!
        expect(registered.type, tool.name).toBe('object')
        for (const keyword of ['oneOf', 'anyOf', 'allOf', 'enum', 'const', 'not']) expect(registered, tool.name).not.toHaveProperty(keyword)
        expect(Object.keys(registered.properties as object), tool.name).toEqual(Object.keys(tool.inputSchema.properties ?? {}))
        expect(registered.required, tool.name).toEqual(tool.inputSchema.required)
        for (const name of (registered.required ?? []) as string[]) expect(registered.properties, tool.name).toHaveProperty(name)
      }
      const target = schemas.find(tool => tool.name.endsWith('r_create_reproduction_record'))!
      expect(target.parameters).toMatchObject({ properties: { title: { type: 'string' }, confirm: { type: 'boolean', default: false } }, required: ['project_id', 'title'] })
      console.log(`Verified ${schemas.length} live MCP schemas; reproduction title and confirmation preserved.`)
    } finally {
      await client.close()
      await ctx.fiber.dispose()
    }
  }, 30_000)
})
