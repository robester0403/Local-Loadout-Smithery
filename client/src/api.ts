import type { Skill, SkillUsageSummary, Timeframe, MCPRow } from './types'

export interface SampleTurn {
  skillName: string
  listingTokens: number
  effectiveTokens: number
  isFirstTurn: boolean
  dollars: number
  model: string
  formula: string
}

export interface BreakdownTurn {
  sessionFile: string
  ts: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  dollars: number
  attribution: 'active' | 'loaded'
  model: string
}

export interface BreakdownSession {
  sessionFile: string
  turns: BreakdownTurn[]
}

// Single response parser. When the server returns a non-OK status with a
// `details` payload (e.g. our 422 field-level validation errors), attach it to
// the thrown Error so the caller can render per-field messages.
async function parseResponse<T>(res: Response): Promise<T> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new Error(`Server error ${res.status}: non-JSON response`)
  }
  if (!res.ok) {
    const b = body as { error?: string; details?: unknown }
    const err = new Error(b.error ?? `Server error ${res.status}`) as Error & { details?: unknown }
    if (b.details !== undefined) err.details = b.details
    throw err
  }
  return body as T
}

/** Optional ecosystem filter:
 *   - 'cursor' → only Cursor's tree
 *   - 'codex'  → only Codex's tree (~/.codex/)
 *   - 'claude' → every detected Claude account (`.claude`, `.claude-*`)
 *   - undefined → everything (the original behavior)
 * Used by the tab-aware loader so each tab only pays for its own scan. */
export type InventoryEcosystem = 'claude' | 'cursor' | 'codex'

export async function fetchInventory(ecosystem?: InventoryEcosystem): Promise<Skill[]> {
  const qs = ecosystem ? `?ecosystem=${ecosystem}` : ''
  const res = await fetch(`/api/inventory${qs}`)
  const data = await parseResponse<{ skills: Skill[] }>(res)
  return data.skills
}

export async function fetchUsageAggregate(timeframe?: Timeframe): Promise<SkillUsageSummary[]> {
  const qs = timeframe && timeframe !== 'all' ? `?timeframe=${timeframe}` : ''
  const res = await fetch(`/api/usage/aggregate${qs}`)
  const data = await parseResponse<{ summaries: SkillUsageSummary[] }>(res)
  return data.summaries
}

export async function openSkill(id: string): Promise<void> {
  const res = await fetch(`/api/skills/${encodeURIComponent(id)}/open`, { method: 'POST' })
  await parseResponse<{ ok: boolean }>(res)
}

export async function setSkillDisabled(id: string, disabled: boolean): Promise<void> {
  const action = disabled ? 'disable' : 'enable'
  const res = await fetch(`/api/skills/${encodeURIComponent(id)}/${action}`, { method: 'POST' })
  await parseResponse<{ ok: boolean }>(res)
}

// Update the description and/or body of a file-backed skill. The server
// rejects unsupported types (MCP) and bad descriptions with HTTP 400.
export async function updateSkillContent(
  id: string,
  patch: { description?: string; body?: string },
): Promise<void> {
  const res = await fetch(`/api/skills/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  await parseResponse<{ ok: boolean }>(res)
}

export async function fetchSampleTurn(timeframe?: Timeframe): Promise<SampleTurn | null> {
  const qs = timeframe && timeframe !== 'all' ? `?timeframe=${timeframe}` : ''
  const res = await fetch(`/api/usage/sample-turn${qs}`)
  const data = await parseResponse<{ sample: SampleTurn | null }>(res)
  return data.sample
}

export async function fetchCostBreakdown(skillId: string, timeframe?: Timeframe): Promise<BreakdownSession[]> {
  const qs = timeframe && timeframe !== 'all' ? `?timeframe=${timeframe}` : ''
  const res = await fetch(`/api/usage/breakdown/${encodeURIComponent(skillId)}${qs}`)
  const data = await parseResponse<{ breakdown: BreakdownSession[] }>(res)
  return data.breakdown
}

export interface ProfilesData {
  profiles: Record<string, string[]>
  activeProfile: string | null
}

export async function fetchProfiles(): Promise<ProfilesData> {
  const res = await fetch('/api/profiles')
  return parseResponse<ProfilesData>(res)
}

export async function createProfile(name: string, skillIds: string[]): Promise<void> {
  const res = await fetch('/api/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, skillIds }),
  })
  await parseResponse<{ ok: boolean }>(res)
}

export async function deleteProfile(name: string): Promise<void> {
  const res = await fetch(`/api/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' })
  await parseResponse<{ ok: boolean }>(res)
}

export async function activateProfile(name: string | null): Promise<void> {
  const slug = name === null ? '__all__' : encodeURIComponent(name)
  const res = await fetch(`/api/profiles/${slug}/activate`, { method: 'POST' })
  await parseResponse<{ ok: boolean }>(res)
}

export interface ReclassifyResult {
  from: string
  to: string
  newId: string
}

export async function reclassifySkill(id: string, newType: string): Promise<ReclassifyResult> {
  const res = await fetch(`/api/skills/${encodeURIComponent(id)}/reclassify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newType }),
  })
  return parseResponse<ReclassifyResult>(res)
}

export async function launchClaude(prompt: string): Promise<{ platform: string; launched?: boolean }> {
  const res = await fetch('/api/launch-claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
  return parseResponse<{ ok: boolean; platform: string; launched?: boolean }>(res)
}

// ─── Skill version history ───────────────────────────────────────────────────

export interface SkillVersion {
  timestamp: string
  sizeBytes: number
}

export async function fetchSkillVersions(id: string): Promise<SkillVersion[]> {
  const res = await fetch(`/api/skills/${encodeURIComponent(id)}/versions`)
  return (await parseResponse<{ versions: SkillVersion[] }>(res)).versions
}

export async function restoreSkillVersion(id: string, timestamp: string): Promise<void> {
  const res = await fetch(
    `/api/skills/${encodeURIComponent(id)}/versions/${encodeURIComponent(timestamp)}/restore`,
    { method: 'POST' },
  )
  await parseResponse<{ ok: boolean }>(res)
}

// Accept the current on-disk content as the shadow-edit baseline. Called by
// the drawer when the user reviews a "shadow edit detected" warning and
// decides the external change is fine.
export async function acceptSkillBaseline(id: string): Promise<void> {
  const res = await fetch(
    `/api/skills/${encodeURIComponent(id)}/baseline/accept`,
    { method: 'POST' },
  )
  await parseResponse<{ ok: boolean }>(res)
}

export interface FrontmatterChange {
  key: string
  before: unknown
  after: unknown
}

export interface BaselineDiff {
  kind: 'unchanged' | 'first-seen' | 'shadow-edit'
  summary?: string
  frontmatterChanges?: FrontmatterChange[]
  bodyBefore?: string
  bodyAfter?: string
}

// Fetch the full diff between the stored baseline and the current on-disk
// content. Used by DiffModal to show per-field frontmatter changes and body diff.
export async function fetchBaselineDiff(id: string): Promise<BaselineDiff> {
  const res = await fetch(`/api/skills/${encodeURIComponent(id)}/baseline/diff`)
  return parseResponse<BaselineDiff>(res)
}

// ─── Security ────────────────────────────────────────────────────────────────

export type FindingSeverity = 'info' | 'medium' | 'high'
export type FindingKind =
  | 'url'
  | 'prompt-injection'
  | 'shell-execution'
  | 'suspicious-unicode'
  | 'env-var-exfil'
  | 'markdown-exfil'
  | 'conditional-activation'
  | 'embedded-base64'
  | 'html-injection'
  | 'suspicious-destination'
  | 'leaked-secret'
  | 'combo-exfil'

export interface SecurityFinding {
  ruleId: string
  kind: FindingKind
  severity: FindingSeverity
  message: string
  evidence: string
  offset: number
  source?: string
  atlasId?: string
}

export interface SecurityScanResult {
  summary: { total: number; high: number; medium: number; info: number }
  findings: SecurityFinding[]
  skillId?: string
}

export async function scanSkillSecurity(id: string): Promise<SecurityScanResult> {
  const res = await fetch(`/api/security/scan/${encodeURIComponent(id)}`)
  return parseResponse<SecurityScanResult>(res)
}

export async function scanTextSecurity(text: string): Promise<SecurityScanResult> {
  const res = await fetch('/api/security/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  return parseResponse<SecurityScanResult>(res)
}

// ─── MCP Usage ───────────────────────────────────────────────────────────────

export interface MCPToolUsage { name: string; calls: number; lastInvoked: string }
export interface MCPUsageSummary {
  serverName: string
  invocations: number
  lastInvoked: string
  tokens: number
  dollars: number
  tools: MCPToolUsage[]
}
export interface MCPRelationship { skillName: string; serverName: string; calls: number }

export async function fetchMCPUsage(timeframe?: Timeframe): Promise<MCPUsageSummary[]> {
  const qs = timeframe && timeframe !== 'all' ? `?timeframe=${timeframe}` : ''
  const res = await fetch(`/api/mcp/usage${qs}`)
  return (await parseResponse<{ summaries: MCPUsageSummary[] }>(res)).summaries
}

export async function fetchMCPRelationships(): Promise<MCPRelationship[]> {
  const res = await fetch('/api/mcp/relationships')
  return (await parseResponse<{ relationships: MCPRelationship[] }>(res)).relationships
}

// ─── MCP Inventory ───────────────────────────────────────────────────────────

export async function fetchMCPInventory(): Promise<MCPRow[]> {
  const res = await fetch('/api/mcp/inventory')
  return (await parseResponse<{ servers: MCPRow[] }>(res)).servers
}

// ─── Uninstall / Trash ───────────────────────────────────────────────────────

export interface UninstalledEntry {
  id: string
  name: string
  description: string
  type: string
  scope: string
  account: string
  originalPath: string
  uninstalledAt: string
}

export async function fetchUninstalled(): Promise<UninstalledEntry[]> {
  const res = await fetch('/api/uninstalled')
  return (await parseResponse<{ entries: UninstalledEntry[] }>(res)).entries
}

export async function uninstallSkillApi(id: string): Promise<void> {
  const res = await fetch(`/api/skills/${encodeURIComponent(id)}/uninstall`, { method: 'POST' })
  await parseResponse<{ ok: boolean }>(res)
}

export async function restoreSkillApi(id: string): Promise<void> {
  const res = await fetch(`/api/uninstalled/${encodeURIComponent(id)}/restore`, { method: 'POST' })
  await parseResponse<{ ok: boolean; restoredPath: string }>(res)
}

export async function permanentDeleteApi(id: string): Promise<void> {
  const res = await fetch(`/api/uninstalled/${encodeURIComponent(id)}`, { method: 'DELETE' })
  await parseResponse<{ ok: boolean }>(res)
}

// ─── Cursor activity ────────────────────────────────────────────────────────

export interface CursorSkillUsage {
  skill: string
  activations: number
  sessions: number
  /** ms epoch; 0 if no timestamp available. */
  lastInvoked: number
}

export interface CursorUsageReport {
  /** True when the Cursor SQLite was found on the host. */
  available: boolean
  skills: CursorSkillUsage[]
  totalActivations: number
  distinctSessions: number
}

export async function fetchCursorUsage(): Promise<CursorUsageReport> {
  const res = await fetch('/api/cursor/usage')
  return parseResponse<CursorUsageReport>(res)
}

// Live activity recorded by the local poller (not bubble-based). Accumulates
// from the moment the LSM server started watching Cursor's recently-used
// lists.
export interface CursorRecentSkillUsage {
  name: string
  kind: 'skill' | 'command' | 'subagent'
  count: number
  firstSeen: number
  lastSeen: number
}

export interface CursorRecentUsageReport {
  hasData: boolean
  trackingSince: number
  items: CursorRecentSkillUsage[]
  totalEvents: number
}

export async function fetchCursorRecentUsage(): Promise<CursorRecentUsageReport> {
  const res = await fetch('/api/cursor/recent-usage')
  return parseResponse<CursorRecentUsageReport>(res)
}

// Triggered by the UI "Rescan projects" button. Runs a depth-limited home
// directory scan server-side and returns the newly-discovered project
// roots (those that weren't already in the persistent log).
export interface CursorRescanResult {
  added: string[]
  addedCount: number
  total: number
}

export async function rescanCursorProjects(): Promise<CursorRescanResult> {
  const res = await fetch('/api/cursor/rescan', { method: 'POST' })
  return parseResponse<CursorRescanResult>(res)
}

// ─── SuperRouter ─────────────────────────────────────────────────────────────

export type BundleTarget = 'claude' | 'cursor' | 'codex'

export type BundleScope =
  | { kind: 'global' }
  | { kind: 'project'; path: string }

export interface BundlePaths {
  topFile: string
  mapFile: string
  mapRelative: string
}

export interface BundleSkillEntry {
  id: string
  description?: string
}

export interface Bundle {
  id: string
  name: string
  slug: string
  target: BundleTarget
  scope: BundleScope
  trigger: string
  skills: BundleSkillEntry[]
  enabled: boolean
  createdAt: string
  updatedAt: string
  paths: BundlePaths
}

export interface BundleInput {
  name: string
  target: BundleTarget
  scope: BundleScope
  trigger: string
  skills: BundleSkillEntry[]
}

// Server-emitted field-level validation errors (HTTP 422).
export interface BundleValidationError {
  field: 'name' | 'trigger' | 'skills' | 'scope' | 'target'
  message: string
  offendingSkillIds?: string[]
}

export async function fetchBundles(): Promise<Bundle[]> {
  const res = await fetch('/api/super-router/bundles')
  return (await parseResponse<{ bundles: Bundle[] }>(res)).bundles
}

export async function createBundleApi(input: BundleInput): Promise<Bundle> {
  const res = await fetch('/api/super-router/bundles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return (await parseResponse<{ bundle: Bundle }>(res)).bundle
}

export async function updateBundleApi(id: string, input: BundleInput): Promise<Bundle> {
  const res = await fetch(`/api/super-router/bundles/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return (await parseResponse<{ bundle: Bundle }>(res)).bundle
}

export async function toggleBundleApi(id: string, enabled: boolean): Promise<Bundle> {
  const res = await fetch(`/api/super-router/bundles/${encodeURIComponent(id)}/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  return (await parseResponse<{ bundle: Bundle }>(res)).bundle
}

export async function deleteBundleApi(id: string): Promise<void> {
  const res = await fetch(`/api/super-router/bundles/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  await parseResponse<{ ok: boolean }>(res)
}

export async function openBundleFileApi(id: string, which: 'top' | 'map'): Promise<void> {
  const res = await fetch(`/api/super-router/bundles/${encodeURIComponent(id)}/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ which }),
  })
  await parseResponse<{ ok: boolean }>(res)
}

export type DriftStatus =
  | 'ok'
  | 'file-missing'
  | 'block-missing'
  | 'markers-corrupted'
  | 'block-modified'
  | 'map-modified'

export interface DriftResult {
  bundleId: string
  status: DriftStatus
  details?: string
}

export async function fetchBundleDrift(): Promise<DriftResult[]> {
  const res = await fetch('/api/super-router/drift')
  return (await parseResponse<{ results: DriftResult[] }>(res)).results
}

// ─── Auto Skill ───────────────────────────────────────────────────────────────

export type CandidateType = 'skill' | 'command' | 'subagent' | 'rule'
export type CandidateStatus = 'pending' | 'accepted' | 'rejected'
export type ConversationSource = 'claude' | 'cursor' | 'codex'

export interface CandidateSourceRef {
  source: ConversationSource
  conversationId: string
  excerpt: string
  at: string
}

export interface ExistingMatch {
  skillId: string
  skillName: string
  skillPath: string
  matchKind: 'name' | 'description'
  similarity: number
  /** Type of the matched existing artifact. May differ from candidate's
   *  suggestedType — e.g. a skill candidate refining an existing command. */
  kind: CandidateType
}

export type ImprovementKind = 'add-to-description' | 'add-to-body' | 'no-improvement'

export interface ImprovementSuggestion {
  kind: ImprovementKind
  text: string
}

export interface ImprovementNotes {
  suggestions: ImprovementSuggestion[]
  comparedAt: string
  model: string
  comparedSkillId: string
}

export interface Candidate {
  id: string
  signature: string
  name: string
  description: string
  bodyDraft: string
  suggestedType: CandidateType
  score: number
  status: CandidateStatus
  sourceRefs: CandidateSourceRef[]
  createdAt: string
  updatedAt: string
  model: string
  acceptedPath?: string
  existingMatch?: ExistingMatch | null
  improvementNotes?: ImprovementNotes

  // Signal-detection pipeline enrichment (LOC-69). Optional; populated when
  // the new pipeline emitted this candidate.
  reasonForUser?: string
  evidenceQuotes?: Array<{ conversationId: string; quote: string }>
  // Rule-only
  ruleText?: string
  suggestedSection?: string
  // Command-only
  promptText?: string
  invocationCount?: number
  suggestedSlug?: string
  // Skill-only (S = (C, π, T, R))
  applicabilityCondition?: string
  procedure?: string[]
  terminationCondition?: string
  expectedOutput?: string
  // Subagent-only
  constituentSkills?: string[]
  orchestrationPattern?: string[]
  inputShape?: string
  outputShape?: string
  // Provenance
  sourceClusterId?: string
}

export interface DigestResult {
  candidatesCreated: number
  candidatesUpdated: number
  conversationsProcessed: number
  chunksProcessed: number
  warnings: string[]
  durationMs: number
  model: string
}

export interface ExtractResult {
  results: Array<{ source: ConversationSource; added: number; skipped: number; warnings: string[] }>
  lastRunAt: string
}

export interface OllamaModel { name: string; size: number; modified_at: string }

export async function fetchOllamaHealth(): Promise<{ available: boolean }> {
  const res = await fetch('/api/ollama/health')
  return parseResponse(res)
}

export async function fetchOllamaModels(): Promise<{ available: boolean; models: OllamaModel[] }> {
  const res = await fetch('/api/ollama/models')
  return parseResponse(res)
}

export interface AppSettings { autoSkill: { model: string } }

export async function fetchSettings(): Promise<AppSettings> {
  const res = await fetch('/api/settings')
  return parseResponse(res)
}

export async function patchSettings(p: Partial<AppSettings>): Promise<AppSettings> {
  const res = await fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  })
  return parseResponse(res)
}

export async function runExtractApi(opts: {
  sources?: ConversationSource[]
  lookbackDays?: number
  /** One-shot bypass of the per-source high-water mark. When true, the
   *  extractor re-pulls conversations within the lookback window even if it
   *  has already seen them. Useful for re-discovering previously-cleared
   *  candidates. The sentinel still updates normally afterward. */
  forceReextract?: boolean
} = {}): Promise<ExtractResult> {
  const res = await fetch('/api/auto-skill/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
  return parseResponse(res)
}

export type DigestPhase = 'idle' | 'starting' | 'chunking' | 'finalizing' | 'done' | 'error'

export interface DigestProgress {
  phase: DigestPhase
  total: number
  completed: number
  message: string
  startedAt: string
  finishedAt: string
  error?: string
}

export async function fetchDigestProgress(): Promise<DigestProgress> {
  const res = await fetch('/api/auto-skill/digest/status')
  return parseResponse(res)
}

export async function runDigestApi(opts: { lookbackDays?: number; model?: string; purgeRawOnSuccess?: boolean } = {}): Promise<DigestResult> {
  const res = await fetch('/api/auto-skill/digest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
  return parseResponse(res)
}

export async function fetchCandidates(): Promise<Candidate[]> {
  const res = await fetch('/api/auto-skill/candidates')
  return (await parseResponse<{ candidates: Candidate[] }>(res)).candidates
}

export async function patchCandidate(id: string, patch: Partial<Pick<Candidate, 'name' | 'description' | 'bodyDraft' | 'suggestedType'>>): Promise<Candidate> {
  const res = await fetch(`/api/auto-skill/candidates/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  return (await parseResponse<{ candidate: Candidate }>(res)).candidate
}

export async function rejectCandidate(id: string): Promise<Candidate> {
  const res = await fetch(`/api/auto-skill/candidates/${encodeURIComponent(id)}/reject`, { method: 'POST' })
  return (await parseResponse<{ candidate: Candidate }>(res)).candidate
}

export async function deleteCandidate(id: string): Promise<void> {
  const res = await fetch(`/api/auto-skill/candidates/${encodeURIComponent(id)}`, { method: 'DELETE' })
  await parseResponse(res)
}

/**
 * Bulk-clear pending or rejected candidates. Server rejects 'accepted' (those
 * have a real on-disk back-pointer and would lose provenance if cleared).
 * Returns the number of candidates removed.
 */
export async function clearCandidates(status: 'pending' | 'rejected'): Promise<number> {
  const res = await fetch('/api/auto-skill/candidates/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  })
  const body = await parseResponse<{ removed: number }>(res)
  return body.removed
}

export interface AcceptInput {
  accountDir: string
  scope: 'global' | 'project'
  projectPath?: string
  name: string
  description: string
  body: string
  type: CandidateType
}

export async function acceptCandidate(id: string, input: AcceptInput): Promise<{ path: string; candidate: Candidate }> {
  const res = await fetch(`/api/auto-skill/candidates/${encodeURIComponent(id)}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return parseResponse(res)
}

export interface AutoSkillAccount { dir: string; label: string }
export async function fetchAutoSkillAccounts(): Promise<AutoSkillAccount[]> {
  const res = await fetch('/api/auto-skill/accounts')
  return (await parseResponse<{ accounts: AutoSkillAccount[] }>(res)).accounts
}

export async function compareCandidateApi(id: string, opts: { model?: string; force?: boolean } = {}): Promise<{ candidate: Candidate; cached: boolean }> {
  const res = await fetch(`/api/auto-skill/candidates/${encodeURIComponent(id)}/compare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
  return parseResponse(res)
}

export async function synthBodyApi(
  id: string,
  opts: { model?: string } = {},
): Promise<{ candidate: Candidate; synthesizedWith: string; sourceMode: 'fresh' | 'excerpts'; conversationsReExtracted: number }> {
  const res = await fetch(`/api/auto-skill/candidates/${encodeURIComponent(id)}/synth-body`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
  return parseResponse(res)
}
