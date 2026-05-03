import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseSessionFile, findSessionFiles } from '../usage/parser'

let tmp: string

function write(p: string, content: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, 'utf-8')
}

function assistantLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: 'abc',
    sessionId: 'session-1',
    timestamp: '2026-05-03T12:00:00.000Z',
    cwd: '/home/user/project',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [
        { type: 'tool_use', name: 'Read', id: 't1', input: {} },
        { type: 'text', text: 'done' },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 300,
      },
    },
    ...overrides,
  })
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-usage-'))
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('parseSessionFile', () => {
  it('extracts a well-formed assistant turn', () => {
    const file = path.join(tmp, 'session1.jsonl')
    write(file, assistantLine() + '\n')

    const warnings: Parameters<typeof parseSessionFile>[1] = []
    const turns = parseSessionFile(file, warnings)

    expect(warnings).toHaveLength(0)
    expect(turns).toHaveLength(1)
    const t = turns[0]
    expect(t.model).toBe('claude-sonnet-4-6')
    expect(t.inputTokens).toBe(100)
    expect(t.outputTokens).toBe(50)
    expect(t.cacheCreationTokens).toBe(200)
    expect(t.cacheReadTokens).toBe(300)
    expect(t.toolUses).toEqual(['Read'])
    expect(t.timestamp).toBe('2026-05-03T12:00:00.000Z')
    expect(t.sessionId).toBe('session-1')
    expect(t.cwd).toBe('/home/user/project')
  })

  it('skips non-assistant lines', () => {
    const file = path.join(tmp, 'session2.jsonl')
    const userLine = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })
    write(file, [userLine, assistantLine()].join('\n') + '\n')

    const warnings: Parameters<typeof parseSessionFile>[1] = []
    const turns = parseSessionFile(file, warnings)
    expect(turns).toHaveLength(1)
  })

  it('skips lines with no usage block', () => {
    const file = path.join(tmp, 'session3.jsonl')
    const noUsage = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', model: 'claude-sonnet-4-6', content: [] },
    })
    write(file, noUsage + '\n')

    const warnings: Parameters<typeof parseSessionFile>[1] = []
    const turns = parseSessionFile(file, warnings)
    expect(turns).toHaveLength(0)
  })

  it('records a warning for invalid JSON lines and continues', () => {
    const file = path.join(tmp, 'session4.jsonl')
    write(file, 'not json\n' + assistantLine() + '\n')

    const warnings: Parameters<typeof parseSessionFile>[1] = []
    const turns = parseSessionFile(file, warnings)
    expect(turns).toHaveLength(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].reason).toBe('Invalid JSON')
  })

  it('handles missing token fields gracefully (defaults to 0)', () => {
    const file = path.join(tmp, 'session5.jsonl')
    const sparse = JSON.stringify({
      type: 'assistant',
      sessionId: 's',
      timestamp: '2026-01-01T00:00:00Z',
      cwd: '/',
      message: {
        role: 'assistant',
        model: 'claude-haiku-4-5',
        content: [],
        usage: { input_tokens: 10 },
      },
    })
    write(file, sparse + '\n')

    const warnings: Parameters<typeof parseSessionFile>[1] = []
    const turns = parseSessionFile(file, warnings)
    expect(turns).toHaveLength(1)
    expect(turns[0].outputTokens).toBe(0)
    expect(turns[0].cacheCreationTokens).toBe(0)
    expect(turns[0].cacheReadTokens).toBe(0)
  })

  it('collects multiple tool_use names', () => {
    const file = path.join(tmp, 'session6.jsonl')
    const multi = JSON.stringify({
      type: 'assistant',
      sessionId: 's',
      timestamp: '',
      cwd: '',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [
          { type: 'tool_use', name: 'Read', id: 't1', input: {} },
          { type: 'tool_use', name: 'Write', id: 't2', input: {} },
          { type: 'text', text: 'ok' },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
    write(file, multi + '\n')

    const warnings: Parameters<typeof parseSessionFile>[1] = []
    const turns = parseSessionFile(file, warnings)
    expect(turns[0].toolUses).toEqual(['Read', 'Write'])
  })
})

describe('findSessionFiles', () => {
  it('finds only top-level jsonl files, not subagent files', () => {
    const fakeHome = path.join(tmp, 'find-home')
    write(path.join(fakeHome, '.claude', 'settings.json'), '{}')
    write(path.join(fakeHome, '.claude', 'projects', 'proj-a', 'session-1.jsonl'), '')
    write(path.join(fakeHome, '.claude', 'projects', 'proj-a', 'subagents', 'agent-x.jsonl'), '')

    const orig = process.env['HOME']
    process.env['HOME'] = fakeHome
    const files = findSessionFiles()
    process.env['HOME'] = orig

    const names = files.map(f => path.basename(f))
    expect(names).toContain('session-1.jsonl')
    expect(names).not.toContain('agent-x.jsonl')
  })
})
