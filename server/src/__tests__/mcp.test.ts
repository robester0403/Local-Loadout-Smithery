import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { toolSchemaBytes } from '../mcp/stdioClient'
import { loadCached, saveCache, clearCache } from '../mcp/cache'
import { detectSessionInjected } from '../mcp/sessionInjected'
import { discoverMCPServers } from '../mcp/discover'

let tmp: string

function write(p: string, content: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, 'utf-8')
}

function jsonlLine(obj: unknown): string {
  return JSON.stringify(obj)
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-mcp-'))
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

// ── toolSchemaBytes ──────────────────────────────────────────────────────────

describe('toolSchemaBytes', () => {
  it('returns byte length of serialized tool definition', () => {
    const tool = { name: 'list_events', description: 'List calendar events', inputSchema: { type: 'object', properties: {} } }
    const expected = Buffer.byteLength(
      JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }),
      'utf-8',
    )
    expect(toolSchemaBytes(tool)).toBe(expected)
  })

  it('uses empty string for missing description and empty object for missing inputSchema', () => {
    const tool = { name: 'noop' }
    const expected = Buffer.byteLength(
      JSON.stringify({ name: 'noop', description: '', inputSchema: {} }),
      'utf-8',
    )
    expect(toolSchemaBytes(tool)).toBe(expected)
  })

  it('larger schemas produce larger byte counts', () => {
    const small = toolSchemaBytes({ name: 'a', description: 'hi', inputSchema: {} })
    const large = toolSchemaBytes({ name: 'a', description: 'hi', inputSchema: { properties: { x: { type: 'string', description: 'x'.repeat(1000) } } } })
    expect(large).toBeGreaterThan(small)
  })
})

// ── Schema cache ─────────────────────────────────────────────────────────────

describe('schema cache', () => {
  it('returns null when no entry exists', () => {
    const home = path.join(tmp, 'home-cache-miss')
    const orig = process.env['HOME']
    process.env['HOME'] = home
    const result = loadCached('no-such-server', 'abc123')
    process.env['HOME'] = orig
    expect(result).toBeNull()
  })

  it('saves and retrieves tools for matching hash', () => {
    const home = path.join(tmp, 'home-cache-hit')
    const orig = process.env['HOME']
    process.env['HOME'] = home

    const tools = [{ name: 'list_events', description: 'List events', schemaBytes: 42 }]
    saveCache('cal', 'hash-1', 'ok', tools)
    const loaded = loadCached('cal', 'hash-1')
    process.env['HOME'] = orig

    expect(loaded).not.toBeNull()
    expect(loaded!.status).toBe('ok')
    expect(loaded!.tools).toHaveLength(1)
    expect(loaded!.tools[0].name).toBe('list_events')
  })

  it('caches unavailable status and returns it', () => {
    const home = path.join(tmp, 'home-cache-unavail')
    const orig = process.env['HOME']
    process.env['HOME'] = home

    saveCache('bad-srv', 'hash-2', 'unavailable', [], 'timeout after 5s')
    const loaded = loadCached('bad-srv', 'hash-2')
    process.env['HOME'] = orig

    expect(loaded).not.toBeNull()
    expect(loaded!.status).toBe('unavailable')
    expect(loaded!.statusReason).toBe('timeout after 5s')
  })

  it('returns null when configHash differs (config changed)', () => {
    const home = path.join(tmp, 'home-cache-hash')
    const orig = process.env['HOME']
    process.env['HOME'] = home

    saveCache('srv', 'old-hash', 'ok', [{ name: 'tool', schemaBytes: 10 }])
    const result = loadCached('srv', 'new-hash')
    process.env['HOME'] = orig

    expect(result).toBeNull()
  })

  it('returns null when cache entry is older than 24h', () => {
    const home = path.join(tmp, 'home-cache-stale')
    const orig = process.env['HOME']
    process.env['HOME'] = home

    // Write a cache file with a fetchedAt 25 hours ago
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    const cacheFile = path.join(home, '.loadoutsmith', 'mcp-cache.json')
    write(cacheFile, JSON.stringify({
      entries: {
        'old-srv': { configHash: 'hash-x', fetchedAt: staleDate, status: 'ok', tools: [{ name: 'old', schemaBytes: 5 }] },
      },
    }))

    const result = loadCached('old-srv', 'hash-x')
    process.env['HOME'] = orig

    expect(result).toBeNull()
  })

  it('clearCache removes all entries', () => {
    const home = path.join(tmp, 'home-cache-clear')
    const orig = process.env['HOME']
    process.env['HOME'] = home

    saveCache('srv', 'h', 'ok', [{ name: 'x', schemaBytes: 1 }])
    clearCache()
    const result = loadCached('srv', 'h')
    process.env['HOME'] = orig

    expect(result).toBeNull()
  })
})

// ── Session-injected detection ────────────────────────────────────────────────

describe('detectSessionInjected', () => {
  const recentTs = new Date().toISOString()

  it('detects mcp__ tool names not in configuredNames', () => {
    const home = path.join(tmp, 'home-injected-basic')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess.jsonl'),
      [
        jsonlLine({
          type: 'assistant',
          timestamp: recentTs,
          message: {
            role: 'assistant', model: 'claude-sonnet-4-6',
            content: [{ type: 'tool_use', id: '1', name: 'mcp__claude_ai_Gmail__list_emails', input: {} }],
            usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
        }),
      ].join('\n'),
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const result = detectSessionInjected(new Set(['github', 'google-calendar']))
    process.env['HOME'] = orig

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('claude_ai_Gmail')
    expect(result[0].tools).toContain('list_emails')
  })

  it('excludes servers that are in configuredNames', () => {
    const home = path.join(tmp, 'home-injected-configured')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess.jsonl'),
      [
        jsonlLine({
          type: 'assistant',
          timestamp: recentTs,
          message: {
            role: 'assistant', model: 'claude-sonnet-4-6',
            content: [{ type: 'tool_use', id: '1', name: 'mcp__github__create_issue', input: {} }],
            usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
        }),
      ].join('\n'),
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const result = detectSessionInjected(new Set(['github']))
    process.env['HOME'] = orig

    expect(result).toHaveLength(0)
  })

  it('aggregates distinct tools per session-injected server', () => {
    const home = path.join(tmp, 'home-injected-multi')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess.jsonl'),
      [
        jsonlLine({ type: 'assistant', timestamp: recentTs, message: { role: 'assistant', model: 'x', content: [{ type: 'tool_use', id: '1', name: 'mcp__claude_ai_Gmail__list_emails', input: {} }], usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
        jsonlLine({ type: 'assistant', timestamp: recentTs, message: { role: 'assistant', model: 'x', content: [{ type: 'tool_use', id: '2', name: 'mcp__claude_ai_Gmail__send_email', input: {} }], usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
        jsonlLine({ type: 'assistant', timestamp: recentTs, message: { role: 'assistant', model: 'x', content: [{ type: 'tool_use', id: '3', name: 'mcp__claude_ai_Gmail__list_emails', input: {} }], usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
      ].join('\n'),
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const result = detectSessionInjected(new Set())
    process.env['HOME'] = orig

    const gmail = result.find((r) => r.name === 'claude_ai_Gmail')
    expect(gmail).toBeDefined()
    expect(gmail!.tools).toEqual(['list_emails', 'send_email']) // sorted
  })

  it('skips lines older than 30 days', () => {
    const home = path.join(tmp, 'home-injected-stale')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    const oldTs = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess.jsonl'),
      jsonlLine({
        type: 'assistant', timestamp: oldTs,
        message: { role: 'assistant', model: 'x', content: [{ type: 'tool_use', id: '1', name: 'mcp__old_server__old_tool', input: {} }], usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      }),
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const result = detectSessionInjected(new Set())
    process.env['HOME'] = orig

    expect(result).toHaveLength(0)
  })

  it('handles server names with hyphens (e.g. google-calendar)', () => {
    const home = path.join(tmp, 'home-injected-hyphen')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess.jsonl'),
      jsonlLine({
        type: 'assistant', timestamp: recentTs,
        message: { role: 'assistant', model: 'x', content: [{ type: 'tool_use', id: '1', name: 'mcp__google-calendar__list-events', input: {} }], usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      }),
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const result = detectSessionInjected(new Set())
    process.env['HOME'] = orig

    const cal = result.find((r) => r.name === 'google-calendar')
    expect(cal).toBeDefined()
    expect(cal!.tools).toContain('list-events')
  })
})

// ── MCP server discovery ──────────────────────────────────────────────────────

describe('discoverMCPServers', () => {
  it('reads mcpServers from ~/.claude.json', () => {
    const home = path.join(tmp, 'home-discover-global')
    write(path.join(home, '.claude.json'), JSON.stringify({
      mcpServers: {
        'my-server': {
          type: 'stdio',
          command: 'my-mcp',
          args: ['start'],
          env: { TOKEN: 'abc' },
        },
      },
    }))

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const servers = discoverMCPServers()
    process.env['HOME'] = orig

    expect(servers).toHaveLength(1)
    expect(servers[0].name).toBe('my-server')
    expect(servers[0].scope).toBe('global')
    expect(servers[0].command).toBe('my-mcp')
    expect(servers[0].args).toEqual(['start'])
    expect(servers[0].type).toBe('stdio')
    expect(servers[0].configHash).toBeTruthy()
  })

  it('different configs produce different hashes', () => {
    const home = path.join(tmp, 'home-discover-hash')
    write(path.join(home, '.claude.json'), JSON.stringify({
      mcpServers: {
        'srv-a': { type: 'stdio', command: 'cmd-a', args: [] },
        'srv-b': { type: 'stdio', command: 'cmd-b', args: [] },
      },
    }))

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const servers = discoverMCPServers()
    process.env['HOME'] = orig

    expect(servers[0].configHash).not.toBe(servers[1].configHash)
  })

  it('returns empty array when no config files exist', () => {
    const home = path.join(tmp, 'home-discover-empty')
    fs.mkdirSync(home, { recursive: true })

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const servers = discoverMCPServers()
    process.env['HOME'] = orig

    expect(servers).toHaveLength(0)
  })

  it('reads project-scoped .mcp.json files', () => {
    const home = path.join(tmp, 'home-discover-project')
    const mcpFile = path.join(home, '.claude', 'projects', 'proj-hash', '.mcp.json')
    write(mcpFile, JSON.stringify({
      mcpServers: {
        'proj-server': { type: 'stdio', command: 'proj-cmd', args: [] },
      },
    }))

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const servers = discoverMCPServers()
    process.env['HOME'] = orig

    expect(servers).toHaveLength(1)
    expect(servers[0].name).toBe('proj-server')
    expect(servers[0].scope).toBe('project')
    expect(servers[0].projectPath).toBe('proj-hash')
  })
})
