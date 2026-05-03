import fs from 'fs'
import os from 'os'
import path from 'path'

const STATE_DIR = path.join(os.homedir(), '.local-skill-manager')
const STATE_FILE = path.join(STATE_DIR, 'state.json')

interface State {
  disabled: string[]
}

function readState(): State {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<State>
    return { disabled: Array.isArray(parsed.disabled) ? parsed.disabled : [] }
  } catch {
    return { disabled: [] }
  }
}

function writeState(state: State): void {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
}

export function getDisabledIds(): Set<string> {
  return new Set(readState().disabled)
}

export function disableSkill(id: string): void {
  const state = readState()
  if (!state.disabled.includes(id)) {
    state.disabled.push(id)
    writeState(state)
  }
}

export function enableSkill(id: string): void {
  const state = readState()
  state.disabled = state.disabled.filter(d => d !== id)
  writeState(state)
}
