export interface MCPServer {
  name: string
  scope: 'global' | 'project'
  projectPath?: string
  type: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  source: string
  configHash: string
}

export interface MCPTool {
  name: string
  description?: string
  inputSchema?: unknown
  schemaBytes: number
}

export type MCPProbeResult =
  | { status: 'ok'; tools: MCPTool[] }
  | { status: 'unavailable'; reason: string }

export interface MCPServerEntry {
  name: string
  kind: 'configured' | 'session-injected'
  scope?: 'global' | 'project'
  transport?: 'stdio' | 'sse' | 'http'
  tools: MCPTool[]
  schemaBytes: number | null
  status: 'ok' | 'unavailable' | 'unknown'
  statusReason?: string
  source?: string
  projectPath?: string
}
