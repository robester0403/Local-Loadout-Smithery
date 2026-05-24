// Shared loader so both the pipeline (runPipeline.ts) and the emit-time
// guardrail (../emit.ts) see the same unified inventory shape across
// Claude / Cursor / Codex.

import { discoverAllSkills } from '../../scanner/discover'
import type { ExistingArtifact } from './dedup'

export function loadExistingInventory(): ExistingArtifact[] {
  const skills = discoverAllSkills()
  // Scanner emits 'skill' | 'command' | 'subagent' | 'mcp'. 'mcp' is not in
  // the candidate space, so it never collides with anything we emit.
  return skills
    .filter(s => s.type === 'skill' || s.type === 'command' || s.type === 'subagent')
    .map(s => ({
      id: s.id,
      name: s.name,
      path: s.path,
      description: s.description,
      kind: s.type as ExistingArtifact['kind'],
    }))
}
