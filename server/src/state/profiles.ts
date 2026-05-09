import fs from 'fs'
import path from 'path'
import { disableSkill, enableSkill } from './index'
import { LOADOUT_DIR } from '../lib/paths'

const STATE_DIR = LOADOUT_DIR
const STATE_FILE = path.join(STATE_DIR, 'state.json')

interface State {
  disabled: string[]
  profiles: Record<string, string[]>
  activeProfile: string | null
  bulkDisabled: string[]
}

function readState(): State {
  try {
    if (!fs.existsSync(STATE_FILE)) return { disabled: [], profiles: {}, activeProfile: null, bulkDisabled: [] }
    const raw = fs.readFileSync(STATE_FILE, 'utf-8')
    const p = JSON.parse(raw)
    return {
      disabled: p.disabled ?? [],
      profiles: p.profiles ?? {},
      activeProfile: p.activeProfile ?? null,
      bulkDisabled: p.bulkDisabled ?? [],
    }
  } catch {
    return { disabled: [], profiles: {}, activeProfile: null, bulkDisabled: [] }
  }
}

function writeState(state: State): void {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

export function listProfiles(): { profiles: Record<string, string[]>; activeProfile: string | null } {
  const { profiles, activeProfile } = readState()
  return { profiles, activeProfile }
}

export function createProfile(name: string, skillIds: string[]): void {
  const state = readState()
  state.profiles[name] = skillIds
  writeState(state)
}

export function deleteProfile(name: string): void {
  const state = readState()
  if (state.activeProfile === name) {
    for (const id of state.bulkDisabled) {
      try { enableSkill(id) } catch { /* file may already be gone */ }
    }
    state.bulkDisabled = []
    state.activeProfile = null
  }
  delete state.profiles[name]
  writeState(state)
}

// allSkills: current inventory snapshot — used to know which IDs exist and which are already disabled
export function activateProfile(
  name: string | null,
  allSkills: Array<{ id: string; disabled: boolean }>,
): void {
  const state = readState()

  // Always re-enable anything we bulk-disabled in the previous activation
  for (const id of state.bulkDisabled) {
    try { enableSkill(id) } catch { /* already enabled or gone */ }
  }
  state.bulkDisabled = []

  if (name === null) {
    state.activeProfile = null
    writeState(state)
    return
  }

  const profileIds = new Set(state.profiles[name] ?? [])
  const newBulkDisabled: string[] = []

  for (const skill of allSkills) {
    if (!profileIds.has(skill.id) && !skill.disabled) {
      try {
        disableSkill(skill.id)
        newBulkDisabled.push(skill.id)
      } catch { /* skip */ }
    }
  }

  state.bulkDisabled = newBulkDisabled
  state.activeProfile = name
  writeState(state)
}
