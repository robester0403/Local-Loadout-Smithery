import fs from 'fs'
import type { Skill, HealthResult, HealthIssue } from './types'

export function computeHealth(skill: Omit<Skill, 'health'>): HealthResult {
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

  // Missing description
  if (!skill.description) {
    issues.push({ severity: 'warn', message: 'Missing description' })
  } else if (skill.description.length < 10) {
    issues.push({ severity: 'warn', message: 'Description too short (< 10 chars)' })
  }

  // Missing allowed-tools (skills and agents benefit from this; commands rarely have it)
  if (skill.type !== 'command' && !skill.frontmatter['allowed-tools']) {
    issues.push({ severity: 'warn', message: 'Missing allowed-tools' })
  }

  const hasError = issues.some(i => i.severity === 'error')
  const hasWarn = issues.some(i => i.severity === 'warn')
  const status = hasError ? 'error' : hasWarn ? 'warn' : 'ok'

  return { status, issues }
}
