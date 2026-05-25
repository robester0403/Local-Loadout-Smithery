import type { SkillReference } from './references'
import type { Diagnostic } from './diagnostics'
export type { SkillReference } from './references'
export type { Diagnostic, DiagnosticKind } from './diagnostics'

export type SkillType = 'skill' | 'command' | 'subagent'

export interface ClassificationResult {
  suggested: SkillType
  confidence: 'high' | 'low'
  cues: string[]
}
export type SkillScope = 'global' | 'project'
export type HealthStatus = 'ok' | 'warn' | 'error'

export interface HealthIssue {
  severity: 'warn' | 'error'
  message: string
}

export interface HealthResult {
  status: HealthStatus
  issues: HealthIssue[]
}

export interface Skill {
  id: string
  name: string
  description: string
  version: string
  type: SkillType
  scope: SkillScope
  account: string
  projectId?: string
  path: string
  realpath: string
  isSymlink: boolean
  body: string
  bodyBytes: number
  bodyTokens: number
  listingBytes: number
  listingTokens: number
  frontmatter: Record<string, unknown>
  lastModified: string
  /** File birthtime (creation time), ISO. Falls back to mtime on Linux/ext4
   *  where birthtime is unreliable. Used client-side to derive `isNew`. */
  installedAt: string
  health: HealthResult
  disabled: boolean
  references: SkillReference[]
  /** Informational diagnostics computed during discovery (LOC-95). Distinct
   *  from `health` — these don't affect the health score; they're hints
   *  the user can act on or ignore. */
  diagnostics: Diagnostic[]
  suggestedType?: ClassificationResult | null
}
