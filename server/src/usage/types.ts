export interface UsageTurn {
  timestamp: string
  sessionId: string
  cwd: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  toolUses: string[]
}

export interface ParseWarning {
  file: string
  line: number
  reason: string
}
