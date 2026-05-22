import fs from 'fs'
import type { Skill, HealthResult, HealthIssue, SkillScope } from './types'
import { scanContent, type Finding } from '../security/scan'
import { diffAgainstBaseline, reconcileBaseline } from '../state/skillBaselines'

// Tool names that indicate a skill actually executes things and should declare allowed-tools.
const TOOL_PATTERN = /\b(Bash|Read|Write|Edit|Glob|Grep|WebFetch|WebSearch|Agent|NotebookEdit)\b/

const COMMON_VERBS = new Set([
  'run','runs','running','execute','executes','executing',
  'generate','generates','generating','create','creates','creating',
  'build','builds','building','analyze','analyzes','analyzing',
  'manage','manages','managing','handle','handles','handling',
  'process','processes','processing','parse','parses','parsing',
  'search','searches','searching','find','finds','finding',
  'update','updates','updating','fetch','fetches','fetching',
  'transform','transforms','transforming','validate','validates','validating',
  'check','checks','checking','detect','detects','detecting',
  'scan','scans','scanning','read','reads','reading',
  'write','writes','writing','list','lists','listing',
  'show','shows','showing','display','displays','displaying',
  'summarize','summarizes','summarizing','review','reviews','reviewing',
  'test','tests','testing','debug','debugs','debugging',
  'deploy','deploys','deploying','install','installs','installing',
  'configure','configures','configuring','setup','set','sets',
  'enable','enables','enabling','disable','disables','disabling',
  'help','helps','helping','assist','assists','assisting',
  'monitor','monitors','monitoring','track','tracks','tracking',
  'convert','converts','converting','format','formats','formatting',
  'send','sends','sending','push','pushes','pushing',
  'sync','syncs','syncing','merge','merges','merging',
  'plan','plans','planning','implement','implements','implementing',
  'research','researches','researching','investigate','investigates','investigating',
  'audit','audits','auditing','report','reports','reporting',
  'launch','launches','launching','start','starts','starting',
  'stop','stops','stopping','restart','restarts','restarting',
  'open','opens','opening','close','closes','closing',
  'load','loads','loading','save','saves','saving',
  'export','exports','exporting','import','imports','importing',
  'draft','drafts','drafting',
  'explain','explains','explaining','describe','describes','describing',
  'guide','guides','guiding','teach','teaches','teaching',
  'iterate','iterates','iterating','orchestrate','orchestrates','orchestrating',
  'coordinate','coordinates','coordinating','delegate','delegates','delegating',
  'infer','infers','inferring','suggest','suggests','suggesting',
  'recommend','recommends','recommending','propose','proposes','proposing',
])

export function computeHealth(
  skill: Omit<Skill, 'health' | 'disabled' | 'suggestedType'>,
  context?: {
    descriptionCounts?: Map<string, number>
    /**
     * When true, use the read-only diffAgainstBaseline instead of
     * reconcileBaseline (which writes the baseline on first-seen). Lets
     * intermediate health computations (e.g. buildSkill's stub pass before
     * the deduped final recompute) avoid double-writing baselines that
     * the final pass will write anyway. Default false (writes on first
     * sighting), preserving the original single-call contract (LOC-50).
     */
    skipBaselineWrite?: boolean
  }
): HealthResult {
  const issues: HealthIssue[] = []

  // Broken symlink — non-functional, hard error
  if (skill.isSymlink) {
    try {
      fs.accessSync(skill.realpath, fs.constants.F_OK)
    } catch {
      issues.push({ severity: 'error', message: 'Broken symlink' })
    }
  }

  // Missing or empty name
  if (!skill.name) {
    issues.push({ severity: 'error', message: 'Missing name' })
  }

  // Description-quality checks only apply to artifacts that get auto-routed
  // by Claude's progressive disclosure (skills, subagents). Slash commands
  // fire on explicit `/name` invocation, so a missing/short/verb-less
  // description is not a defect — flagging it just creates noise.
  if (skill.type !== 'command') {
    if (!skill.description) {
      issues.push({ severity: 'warn', message: 'Missing description' })
    } else if (skill.description.length < 20) {
      issues.push({ severity: 'warn', message: "Description too short — Claude can't match it for progressive disclosure" })
    } else {
      // No verb in first 10 words
      const first10 = skill.description.split(/\s+/).slice(0, 10).map(w => w.toLowerCase().replace(/[^a-z]/g, ''))
      const hasVerb = first10.some(w => COMMON_VERBS.has(w))
      if (!hasVerb) {
        issues.push({ severity: 'warn', message: 'Description has no clear action verb — add one so Claude knows when to use this skill' })
      }

      // Duplicate description
      if (context?.descriptionCounts) {
        const key = skill.description.toLowerCase().trim()
        const count = context.descriptionCounts.get(key) ?? 0
        if (count >= 2) {
          issues.push({ severity: 'warn', message: 'Description is identical to another skill — Claude may load the wrong one' })
        }
      }
    }
  }

  // Missing allowed-tools — only flag if the body actually references tool calls.
  // Documentation-only skills without tool use don't need allowed-tools.
  if (
    skill.type !== 'command' &&
    !skill.frontmatter['allowed-tools'] &&
    TOOL_PATTERN.test(skill.body)
  ) {
    issues.push({ severity: 'warn', message: 'Uses tools but missing allowed-tools' })
  }

  // Scope mismatch detection
  if (skill.body) {
    const scopeIssue = detectScopeMismatch(skill.scope, skill.body)
    if (scopeIssue) issues.push(scopeIssue)
  }

  // Security findings — fold into the same issues list so the existing UI
  // (drawer accordion, Needs-review filter, inventory row badge, diagnostics
  // tile) surfaces them without separate plumbing. Only high/medium findings
  // bump the skill's health status; info-only findings (plain URLs) stay
  // visible in the drawer's dedicated security section but don't mark the
  // skill as "needs review."
  if (skill.body || skill.description) {
    const text = `${skill.description ?? ''}\n\n${skill.body ?? ''}`
    for (const finding of scanContent(text)) {
      const mapped = securityFindingToHealthIssue(finding)
      if (mapped) issues.push(mapped)
    }
  }

  // Shadow-edit detection — compare the current body against the last-
  // observed baseline. First sighting silently writes the baseline (we
  // can't retroactively know pre-LSM history); subsequent sightings with
  // different content surface as a warn-level health issue.
  //
  // When skipBaselineWrite is set, we read the baseline but don't write
  // it — the caller has another pass that will reconcile authoritatively.
  if (skill.body !== undefined) {
    const drift = context?.skipBaselineWrite
      ? diffAgainstBaseline(skill.id, skill.body)
      : reconcileBaseline(skill.id, skill.body)
    if (drift.kind === 'shadow-edit') {
      const detail = drift.summary ? ` ${drift.summary}.` : ''
      issues.push({
        severity: 'warn',
        message: `Shadow edit detected — file was modified outside Loadout Smithery since last seen.${detail} Open the drawer to accept or restore.`,
      })
    }
  }

  const hasError = issues.some(i => i.severity === 'error')
  const hasWarn = issues.some(i => i.severity === 'warn')
  const status = hasError ? 'error' : hasWarn ? 'warn' : 'ok'

  return { status, issues }
}

// Severity mapping: scanner `high` → health `error`, scanner `medium` → health
// `warn`, scanner `info` → not surfaced as a health issue (still visible in
// the drawer's security accordion via the dedicated API).
function securityFindingToHealthIssue(f: Finding): HealthIssue | null {
  if (f.severity === 'info') return null
  return {
    severity: f.severity === 'high' ? 'error' : 'warn',
    message: `Security: ${f.message}`,
  }
}

const GLOBAL_PATH_RE = /\/Users\/([^\s"')\]]+)/
const ENV_RE = /\.env\b/i
const PROJECT_PHRASES = ['this project', 'this repo', 'in our codebase']
const GENERIC_PHRASES = ['any codebase', 'across projects', 'regardless of stack']

function detectScopeMismatch(scope: SkillScope, body: string): HealthIssue | null {
  const lower = body.toLowerCase()

  if (scope === 'global') {
    const pathMatch = GLOBAL_PATH_RE.exec(body)
    if (pathMatch) {
      return { severity: 'warn', message: `Global skill references project-specific path: ${pathMatch[0]}` }
    }
    if (ENV_RE.test(body)) {
      return { severity: 'warn', message: 'Global skill references .env — consider making this project-scoped' }
    }
    for (const phrase of PROJECT_PHRASES) {
      if (lower.includes(phrase)) {
        return { severity: 'warn', message: `Global skill contains project-specific phrase: "${phrase}"` }
      }
    }
  }

  if (scope === 'project') {
    const hasAnchor =
      GLOBAL_PATH_RE.test(body) ||
      ENV_RE.test(body) ||
      PROJECT_PHRASES.some(p => lower.includes(p))
    if (!hasAnchor) {
      for (const phrase of GENERIC_PHRASES) {
        if (lower.includes(phrase)) {
          return { severity: 'warn', message: `Project skill uses generic phrasing ("${phrase}") with no project-specific anchors` }
        }
      }
    }
  }

  return null
}
