// Orchestrator (LOC-79). Wires every phase of the signal-detection pipeline
// (LOC-69) end-to-end: load conversations → arc-segment → summarize → cluster
// → 4 parallel detectors → dedup against existing library → rank → annotate
// reasons → persist as Candidates via the existing store.
//
// The legacy free-form digest (`runDigest` in ../digest.ts) stays in place;
// dispatch happens in digest.ts on the `Settings.autoSkill.useSignalPipeline`
// flag added in LOC-70. Both paths persist into the same Candidate store.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { generate, isAvailable } from '../../ollama/client'
import type { ConversationRecord } from '../../extractors/types'
import { upsertGenerated } from '../store'
import * as progress from '../progress'
import type { Candidate, DigestResult } from '../types'

import { segmentIntoArcs } from './arcs'
import { summarizeArc, type LlmSummarizeFn } from './summarize'
import { openSummaryCache, type SummaryCache } from './summaryCache'
import { clusterSummaries } from './cluster'
import { embedText, clearEmbedCache } from './embed'
import { detectRules, type RuleClassifierFn } from './detectors/rules'
import { detectCommands } from './detectors/commands'
import { detectSkills, type SkillSynthFn, type SkillConsistencyFn } from './detectors/skills'
import { detectSubagents, type SubagentSynthFn, type SkillRef } from './detectors/subagents'
import { deduplicateCandidates, type ExistingArtifact } from './dedup'
import { collapseCrossDetector, rejectNameCollisions } from './crossDedup'
import { loadExistingInventory } from './existingInventory'
import { rankCandidates } from './rank'
import { annotateWithReason } from './explain'
import { readExistingRuleFiles } from './lib/ruleMarkers'
import type { ConversationSummary, IntentCluster, SubGoalArc } from './types'

const CONVERSATIONS_ROOT = path.join(os.homedir(), '.loadoutsmith', 'conversations')

export type GeneratedCandidate = Omit<Candidate, 'id' | 'status' | 'createdAt' | 'updatedAt'>

export interface SignalPipelineOptions {
  /** Discovery / summarization / synth model. Default Settings.autoSkill.model
   *  (caller must pass it; we don't read settings here). */
  model: string
  /** ISO cutoff — conversations older than this are skipped. */
  sinceIso?: string
  /** Override the loaded conversations (tests). */
  conversationsOverride?: ConversationRecord[]
  /** Override the existing-skills inventory (tests). */
  existingSkillsOverride?: ExistingArtifact[]
  /** Override the existing-rule files for dedup (tests). */
  existingRuleFilesOverride?: ReturnType<typeof readExistingRuleFiles>
  /** Inject summarizer LLM (tests). */
  summarizeFn?: LlmSummarizeFn
  /** Inject rule classifier (tests). */
  ruleClassifierFn?: RuleClassifierFn
  /** Inject skill synth LLM (tests). */
  skillSynthFn?: SkillSynthFn
  /** Inject skill consistency LLM (tests). */
  skillConsistencyFn?: SkillConsistencyFn
  /** Inject subagent synth LLM (tests). */
  subagentSynthFn?: SubagentSynthFn
  /** Inject embedder (tests). */
  embedFn?: (text: string) => Promise<number[]>
  /** Inject summary cache (tests). Defaults to on-disk cache. */
  summaryCache?: SummaryCache
  /** Skip the Ollama availability check (tests). */
  skipOllamaCheck?: boolean
}

export interface SignalPipelineResult extends DigestResult {
  /** Per-phase counts useful for understanding why a digest produced N candidates. */
  arcsProduced: number
  summariesProduced: number
  clustersProduced: number
  ruleCandidates: number
  commandCandidates: number
  skillCandidates: number
  subagentCandidates: number
  /** Warnings from individual detectors, surfaced for diagnostics. */
  detectorWarnings: string[]
}

export async function runSignalPipeline(opts: SignalPipelineOptions): Promise<SignalPipelineResult> {
  const start = Date.now()
  const warnings: string[] = []
  const detectorWarnings: string[] = []
  const sinceMs = opts.sinceIso ? Date.parse(opts.sinceIso) : Date.now() - 14 * 24 * 60 * 60 * 1000

  progress.start(`Preparing signal-detection pipeline with ${opts.model || '(no model)'}…`)
  try {
    if (!opts.model) throw new Error('No model selected — set autoSkill.model in settings.')
    if (!opts.skipOllamaCheck && !(await isAvailable())) {
      throw new Error('Ollama is not reachable on http://localhost:11434')
    }

    // 1. Load + filter conversations.
    progress.setPhase('chunking', 'Loading extracted conversations…')
    const all = opts.conversationsOverride ?? loadAllConversations()
    const conversations = all.filter(c => {
      const t = Date.parse(c.startedAt || c.endedAt || '')
      return Number.isFinite(t) ? t >= sinceMs : true
    })

    // 2. Phase 0 — arc segmentation.
    progress.setPhase('chunking', `Segmenting ${conversations.length} conversation(s) into arcs…`)
    const arcs: Array<{ arc: SubGoalArc; conversation: ConversationRecord }> = []
    for (const c of conversations) {
      const segs = await segmentIntoArcs(c)
      for (const a of segs) arcs.push({ arc: a, conversation: c })
    }
    progress.setTotal(arcs.length, `Summarizing ${arcs.length} arc(s)…`)

    // 3. Phase 1 — per-arc summarize (with cache).
    const summarizer: LlmSummarizeFn = opts.summarizeFn ?? defaultSummarizer(opts.model)
    const cache = opts.summaryCache ?? openSummaryCache()
    const summaries: ConversationSummary[] = []
    for (const { arc, conversation } of arcs) {
      try {
        const s = await summarizeArc(arc, conversation, {
          model: opts.model,
          llmFn: summarizer,
          cache,
        })
        if (s) summaries.push(s)
      } catch (e) {
        warnings.push(`Summarize failed for ${arc.arcId}: ${(e as Error).message}`)
      }
      progress.tick()
    }

    // 4. Phase 2 — cluster.
    progress.setPhase('chunking', `Clustering ${summaries.length} summaries…`)
    clearEmbedCache()
    const embedFn = opts.embedFn ?? ((t: string) => embedText(t))
    const clusters: IntentCluster[] = await clusterSummaries(summaries, {
      embedFn,
      preserveEmbedCache: true,
      nowMs: Date.now(),
    })
    progress.setPhase('chunking', `Detected ${clusters.length} intent cluster(s).`)

    // 5. Phase 3 — four detectors. Skill detector runs FIRST so the subagent
    //    detector can consume its candidates; the other three are independent
    //    and run in parallel after.
    const existingInventory = opts.existingSkillsOverride ?? loadExistingInventory()
    const existingSkillNames = new Set(existingInventory.filter(a => a.kind === 'skill').map(a => a.name))

    progress.setPhase('chunking', 'Running detectors…')

    const existingRules = opts.existingRuleFilesOverride ?? readExistingRuleFiles()

    // Skill detector first — produces the candidate list that the subagent
    // detector needs as part of its `availableSkills`. Without this, the
    // subagent detector either misses orchestration patterns involving
    // newly-proposed skills, or (the previous bug) calls detectSkills
    // a SECOND time, doubling LLM cost per surviving cluster.
    const skillResult = await detectSkills(clusters, summaries, {
      llmSynthFn: opts.skillSynthFn,
      llmConsistencyFn: opts.skillConsistencyFn,
      model: opts.model,
    })

    const subagentAvailableSkills: SkillRef[] = [
      ...existingInventory.filter(a => a.kind === 'skill').map(a => ({ name: a.name, description: a.description })),
      ...skillResult.candidates.map(c => ({ name: c.name, description: c.description })),
    ]

    const [ruleResult, commandList, subagentResult] = await Promise.all([
      detectRules(summaries, clusters, {
        existingRuleFiles: existingRules,
        llmClassifier: opts.ruleClassifierFn ?? defaultRuleClassifier(opts.model),
        embedFn,
        model: opts.model,
      }),
      Promise.resolve(detectCommands(summaries, {
        existingCommandTexts: existingInventory
          .filter(a => a.kind === 'command')
          .map(a => `${a.name}\n${a.description}`),
        model: opts.model,
      })),
      detectSubagents(summaries, subagentAvailableSkills, {
        embedFn,
        llmSynthFn: opts.subagentSynthFn,
        model: opts.model,
      }),
    ])

    for (const w of skillResult.warnings) detectorWarnings.push(`skill[${w.clusterId}]: ${w.reason} — ${w.detail}`)
    for (const w of subagentResult.warnings) detectorWarnings.push(`subagent[${w.patternKey}]: ${w.reason} — ${w.detail}`)

    const allCandidates: GeneratedCandidate[] = [
      ...ruleResult,
      ...commandList,
      ...skillResult.candidates,
      ...subagentResult.candidates,
    ]

    // 6a. Phase 3.5 — cross-detector dedup (LOC-89). Collapse semantically
    //     equivalent candidates that came back from multiple detectors, then
    //     drop any candidate whose slug collides with another candidate or
    //     an existing artifact of any type. Both passes surface their drops
    //     as detectorWarnings so the user can see what was suppressed.
    progress.setPhase('finalizing', `Collapsing ${allCandidates.length} candidates across detectors…`)
    const collapsed = await collapseCrossDetector(allCandidates, { embedFn })
    for (const d of collapsed.dropped) detectorWarnings.push(`crossDedup: ${d.reason}`)
    const uniqueByName = rejectNameCollisions(collapsed.kept, existingInventory)
    for (const d of uniqueByName.dropped) detectorWarnings.push(`crossDedup: ${d.reason}`)

    // 6b. Phase 4 — dedup against existing library (now cross-type).
    progress.setPhase('finalizing', `Deduplicating ${uniqueByName.kept.length} candidates…`)
    const deduped = await deduplicateCandidates(uniqueByName.kept, existingInventory, { embedFn })

    // 7. Phase 5 — rank.
    const clusterById = new Map(clusters.map(c => [c.clusterId, c]))
    const summariesByArc = new Map(summaries.map(s => [s.arcId, s]))
    const ranked = rankCandidates(deduped, {
      clustersById: clusterById,
      summariesByArc,
      existingSkillNames,
      nowMs: Date.now(),
    })

    // 8. Phase 6 — annotate reasons.
    const annotated = annotateWithReason(ranked, {
      clustersById: clusterById,
      summariesByArc,
      nowMs: Date.now(),
    })

    // 9. Persist via existing store.
    let created = 0
    let updated = 0
    for (const c of annotated) {
      const r = upsertGenerated(c)
      if (r.created) created += 1
      else updated += 1
    }

    const ruleCount = annotated.filter(c => c.suggestedType === 'rule').length
    const commandCount = annotated.filter(c => c.suggestedType === 'command').length
    const skillCount = annotated.filter(c => c.suggestedType === 'skill').length
    const subagentCount = annotated.filter(c => c.suggestedType === 'subagent').length

    progress.done(`Done. ${created} new, ${updated} updated.`)
    return {
      candidatesCreated: created,
      candidatesUpdated: updated,
      conversationsProcessed: conversations.length,
      chunksProcessed: arcs.length,
      warnings: [...warnings, ...detectorWarnings],
      durationMs: Date.now() - start,
      model: opts.model,
      arcsProduced: arcs.length,
      summariesProduced: summaries.length,
      clustersProduced: clusters.length,
      ruleCandidates: ruleCount,
      commandCandidates: commandCount,
      skillCandidates: skillCount,
      subagentCandidates: subagentCount,
      detectorWarnings,
    }
  } catch (e) {
    progress.fail((e as Error).message)
    throw e
  }
}

// ---- Loaders ----------------------------------------------------------------

function loadAllConversations(): ConversationRecord[] {
  if (!fs.existsSync(CONVERSATIONS_ROOT)) return []
  const out: ConversationRecord[] = []
  for (const source of fs.readdirSync(CONVERSATIONS_ROOT)) {
    if (source.startsWith('.')) continue
    const dir = path.join(CONVERSATIONS_ROOT, source)
    let stat: fs.Stats
    try { stat = fs.statSync(dir) } catch { continue }
    if (!stat.isDirectory()) continue
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue
      const raw = fs.readFileSync(path.join(dir, file), 'utf-8')
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          out.push(JSON.parse(trimmed) as ConversationRecord)
        } catch { /* skip malformed line */ }
      }
    }
  }
  return out
}

// ---- Default LLM functions (route through ollama.generate) ------------------

function defaultSummarizer(model: string): LlmSummarizeFn {
  return async (prompt: string) => generate({ model, prompt, json: true, temperature: 0.2, timeoutMs: 120_000 })
}

function defaultRuleClassifier(model: string): RuleClassifierFn {
  return async (directives: string[]) => {
    if (directives.length === 0) return []
    const numbered = directives.map((d, i) => `${i + 1}. ${d}`).join('\n')
    const prompt = [
      'Classify each candidate directive below as either a CONVENTION (always-on, applies across tasks) or TASK-SPECIFIC (only relevant to one type of work).',
      '',
      'Directives:',
      numbered,
      '',
      'Return STRICT JSON: { "classifications": [bool, ...] } where true means CONVENTION.',
      'Output one entry per directive in order.',
    ].join('\n')
    const raw = await generate({ model, prompt, json: true, temperature: 0.1, timeoutMs: 60_000 })
    // Parse defensively. On any failure (malformed JSON, wrong-shape array,
    // length mismatch) we DROP the directives rather than accept them — a
    // bogus rule pollutes the user's CLAUDE.md on accept, which is much
    // worse than missing one digest cycle of a real rule.
    const parsed = JSON.parse(raw) as { classifications?: unknown }
    const arr = parsed.classifications
    if (!Array.isArray(arr) || arr.length !== directives.length) {
      return directives.map(() => false)
    }
    return directives.map((_, i) => arr[i] === true)
  }
}
