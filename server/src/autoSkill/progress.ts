// In-memory digest progress. Single-user local app, so a single global
// state machine is fine — the only restraint we enforce is that two
// digests can't run concurrently (the second POST gets 409).

export type DigestPhase = 'idle' | 'starting' | 'chunking' | 'finalizing' | 'done' | 'error'

export interface DigestProgress {
  phase: DigestPhase
  /** Total chunks the run will process. 0 while still computing. */
  total: number
  /** Chunks finished so far. */
  completed: number
  /** Free-form status line for the UI ("Chunking 64 conversations…",
   *  "Processing chunk 3/7", "Purging raw conversations…"). */
  message: string
  /** ISO timestamps of run boundaries. */
  startedAt: string
  finishedAt: string
  /** Set when phase === 'error'. */
  error?: string
}

let state: DigestProgress = {
  phase: 'idle',
  total: 0,
  completed: 0,
  message: '',
  startedAt: '',
  finishedAt: '',
}

export function getProgress(): DigestProgress {
  return { ...state }
}

export function isRunning(): boolean {
  return state.phase !== 'idle' && state.phase !== 'done' && state.phase !== 'error'
}

export function start(message = 'Starting digest…'): void {
  state = {
    phase: 'starting',
    total: 0,
    completed: 0,
    message,
    startedAt: new Date().toISOString(),
    finishedAt: '',
  }
}

export function setTotal(total: number, message?: string): void {
  state = { ...state, phase: 'chunking', total, message: message ?? state.message }
}

export function tick(message?: string): void {
  state = { ...state, completed: state.completed + 1, message: message ?? state.message }
}

export function setPhase(phase: DigestPhase, message?: string): void {
  state = { ...state, phase, message: message ?? state.message }
}

export function done(message = 'Done.'): void {
  state = { ...state, phase: 'done', message, finishedAt: new Date().toISOString() }
}

export function fail(error: string): void {
  state = { ...state, phase: 'error', error, finishedAt: new Date().toISOString() }
}

// For tests + manual reset paths.
export function reset(): void {
  state = { phase: 'idle', total: 0, completed: 0, message: '', startedAt: '', finishedAt: '' }
}
