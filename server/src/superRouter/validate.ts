import path from 'path'
import type { Skill } from '../scanner/types'
import type { BundleInput } from './types'

export interface ValidationError {
  field: 'name' | 'trigger' | 'skills' | 'scope' | 'target'
  message: string
  offendingSkillIds?: string[]
}

function isSkillUnder(skill: Skill, projectPath: string): boolean {
  const normProject = path.resolve(projectPath)
  const normSkill = path.resolve(skill.path)
  return normSkill === normProject || normSkill.startsWith(normProject + path.sep)
}

export function validateBundleInput(
  input: BundleInput,
  allSkills: Skill[],
): ValidationError[] {
  const errors: ValidationError[] = []

  if (!input.name || input.name.trim().length === 0) {
    errors.push({ field: 'name', message: 'Name is required.' })
  }
  if (!input.trigger || input.trigger.trim().length === 0) {
    errors.push({ field: 'trigger', message: 'Trigger description is required.' })
  }
  if (input.target !== 'claude' && input.target !== 'cursor' && input.target !== 'codex') {
    errors.push({ field: 'target', message: 'Target must be "claude", "cursor", or "codex".' })
  }
  if (!input.scope || (input.scope.kind !== 'global' && input.scope.kind !== 'project')) {
    errors.push({ field: 'scope', message: 'Scope must be global or project.' })
  } else if (input.scope.kind === 'project' && !input.scope.path) {
    errors.push({ field: 'scope', message: 'Project scope requires a path.' })
  }
  if (!Array.isArray(input.skills) || input.skills.length === 0) {
    errors.push({ field: 'skills', message: 'At least one skill must be selected.' })
  }

  if (Array.isArray(input.skills) && input.skills.length > 0) {
    const byId = new Map(allSkills.map(s => [s.id, s]))
    const missing = input.skills.filter(e => !byId.has(e.id)).map(e => e.id)
    if (missing.length > 0) {
      errors.push({
        field: 'skills',
        message: 'Some selected skills no longer exist.',
        offendingSkillIds: missing,
      })
    }

    if (input.scope?.kind === 'project') {
      const projectPath = input.scope.path
      const outOfScope: string[] = []
      for (const entry of input.skills) {
        const s = byId.get(entry.id)
        if (!s) continue
        if (!isSkillUnder(s, projectPath)) outOfScope.push(entry.id)
      }
      if (outOfScope.length > 0) {
        errors.push({
          field: 'skills',
          message: 'Some skills are not located under the selected project.',
          offendingSkillIds: outOfScope,
        })
      }
    }

    // Require a per-bundle description when the source has none. The map
    // file is the LLM's only signal for picking a skill once the trigger
    // fires; without text under the heading the entry is dead weight.
    const needDescription: string[] = []
    for (const entry of input.skills) {
      const source = byId.get(entry.id)
      if (!source) continue
      const sourceHas = source.description && source.description.trim().length > 0
      const entryHas = entry.description && entry.description.trim().length > 0
      if (!sourceHas && !entryHas) needDescription.push(entry.id)
    }
    if (needDescription.length > 0) {
      errors.push({
        field: 'skills',
        message: 'Some items need a "when to use" description (the source has none).',
        offendingSkillIds: needDescription,
      })
    }
  }

  return errors
}
