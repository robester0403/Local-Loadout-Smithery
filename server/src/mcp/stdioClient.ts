import { spawn } from 'child_process'
import type { MCPTool, MCPProbeResult } from './types'

const TIMEOUT_MS = 5000

// Bytes of the serialized tool definition that Claude injects into the API tools parameter.
export function toolSchemaBytes(tool: {
  name: string
  description?: string
  inputSchema?: unknown
}): number {
  return Buffer.byteLength(
    JSON.stringify({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema ?? {},
    }),
    'utf-8',
  )
}

export async function probeMCPStdio(
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<MCPProbeResult> {
  return new Promise((resolve) => {
    let settled = false

    const finish = (result: MCPProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        proc.kill()
      } catch {
        /* already dead */
      }
      resolve(result)
    }

    const timer = setTimeout(() => {
      finish({ status: 'unavailable', reason: 'timeout after 5s' })
    }, TIMEOUT_MS)

    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(command, args, {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      clearTimeout(timer)
      resolve({ status: 'unavailable', reason: `spawn failed: ${(err as Error).message}` })
      return
    }

    proc.on('error', (err) => {
      finish({ status: 'unavailable', reason: `process error: ${err.message}` })
    })

    function send(msg: unknown) {
      const line = JSON.stringify(msg) + '\n'
      try {
        proc.stdin.write(line)
      } catch {
        /* stdin may already be closed */
      }
    }

    let buffer = ''
    let phase: 'init' | 'tools' | 'done' = 'init'
    const TOOLS_ID = 2

    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(trimmed) as Record<string, unknown>
        } catch {
          continue
        }

        if (phase === 'init') {
          if (msg['id'] === 1 && msg['result'] !== undefined) {
            // Acknowledge initialization then request tool list
            send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
            send({ jsonrpc: '2.0', id: TOOLS_ID, method: 'tools/list', params: {} })
            phase = 'tools'
          } else if (msg['error']) {
            finish({
              status: 'unavailable',
              reason: `initialize error: ${JSON.stringify(msg['error'])}`,
            })
          }
        } else if (phase === 'tools') {
          if (msg['id'] === TOOLS_ID) {
            if (msg['result']) {
              const result = msg['result'] as Record<string, unknown>
              const rawTools = Array.isArray(result['tools'])
                ? (result['tools'] as Record<string, unknown>[])
                : []
              const tools: MCPTool[] = rawTools
                .filter((t) => typeof t['name'] === 'string' && t['name'])
                .map((t) => {
                  const name = t['name'] as string
                  const description =
                    typeof t['description'] === 'string' ? t['description'] : undefined
                  const inputSchema = t['inputSchema']
                  return {
                    name,
                    description,
                    inputSchema,
                    schemaBytes: toolSchemaBytes({ name, description, inputSchema }),
                  }
                })
              phase = 'done'
              finish({ status: 'ok', tools })
            } else {
              finish({
                status: 'unavailable',
                reason: `tools/list error: ${JSON.stringify(msg['error'])}`,
              })
            }
          }
        }
      }
    })

    proc.on('close', (code) => {
      if (!settled) {
        finish({ status: 'unavailable', reason: `process exited with code ${code}` })
      }
    })

    // Start the JSON-RPC handshake
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'local-skill-manager', version: '0.1.0' },
      },
    })
  })
}
