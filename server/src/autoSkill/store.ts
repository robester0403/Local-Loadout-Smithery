import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import type { Candidate, CandidateStatus, ImprovementNotes } from './types'

function file(): string {
  return path.join(os.homedir(), '.loadoutsmith', 'auto-skill', 'candidates.json')
}

function legacyFile(): string {
  // Pre-rename location: kept around long enough to migrate existing
  // candidates the user produced under the 'harvester' branding.
  return path.join(os.homedir(), '.loadoutsmith', 'harvester', 'candidates.json')
}

// If the new file doesn't exist but the legacy one does, copy it over on
// first access. Safe to run on every read — the existsSync guards prevent
// re-migration once the new file is in place.
function migrateLegacyIfNeeded(): void {
  const target = file()
  if (fs.existsSync(target)) return
  const legacy = legacyFile()
  if (!fs.existsSync(legacy)) return
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(legacy, target)
  } catch { /* if migration fails, fall through to empty state */ }
}

interface Shape { candidates: Candidate[] }

export function readAll(): Candidate[] {
  migrateLegacyIfNeeded()
  try {
    if (!fs.existsSync(file())) return []
    const raw = JSON.parse(fs.readFileSync(file(), 'utf-8')) as Partial<Shape>
    return Array.isArray(raw.candidates) ? raw.candidates : []
  } catch {
    return []
  }
}

function persist(candidates: Candidate[]): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  const tmp = file() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify({ candidates }, null, 2))
  fs.renameSync(tmp, file())
}

export function getById(id: string): Candidate | undefined {
  return readAll().find(c => c.id === id)
}

export function setStatus(id: string, status: CandidateStatus, acceptedPath?: string): Candidate {
  const all = readAll()
  const idx = all.findIndex(c => c.id === id)
  if (idx === -1) throw new Error(`Candidate ${id} not found`)
  all[idx] = {
    ...all[idx],
    status,
    acceptedPath: acceptedPath ?? all[idx].acceptedPath,
    updatedAt: new Date().toISOString(),
  }
  persist(all)
  return all[idx]
}

export function updateFields(id: string, patch: Partial<Pick<Candidate, 'name' | 'description' | 'bodyDraft' | 'suggestedType'>>): Candidate {
  const all = readAll()
  const idx = all.findIndex(c => c.id === id)
  if (idx === -1) throw new Error(`Candidate ${id} not found`)
  all[idx] = { ...all[idx], ...patch, updatedAt: new Date().toISOString() }
  persist(all)
  return all[idx]
}

export function deleteById(id: string): void {
  persist(readAll().filter(c => c.id !== id))
}

export function setImprovementNotes(id: string, notes: ImprovementNotes): Candidate {
  const all = readAll()
  const idx = all.findIndex(c => c.id === id)
  if (idx === -1) throw new Error(`Candidate ${id} not found`)
  all[idx] = { ...all[idx], improvementNotes: notes, updatedAt: new Date().toISOString() }
  persist(all)
  return all[idx]
}

// Upsert a freshly-generated candidate. Dedup is signature-based: if a
// candidate with the same (type + slugified name) already exists, merge the
// sourceRefs (deduped by conversationId) and bump the score; preserve the
// user's status if it's already been triaged.
export function upsertGenerated(c: Omit<Candidate, 'id' | 'status' | 'createdAt' | 'updatedAt'>): { created: boolean; candidate: Candidate } {
  const all = readAll()
  const existing = all.find(x => x.signature === c.signature)
  const now = new Date().toISOString()

  if (existing) {
    const seen = new Set(existing.sourceRefs.map(r => r.conversationId))
    const mergedRefs = [...existing.sourceRefs]
    for (const ref of c.sourceRefs) {
      if (!seen.has(ref.conversationId)) {
        mergedRefs.push(ref)
        seen.add(ref.conversationId)
      }
    }
    const next: Candidate = {
      ...existing,
      // Update text only if the user hasn't already triaged the candidate;
      // otherwise we'd silently overwrite their edits next digest run.
      ...(existing.status === 'pending'
        ? { name: c.name, description: c.description, bodyDraft: c.bodyDraft, suggestedType: c.suggestedType }
        : {}),
      sourceRefs: mergedRefs,
      score: Math.max(existing.score, c.score),
      model: c.model,
      updatedAt: now,
    }
    persist(all.map(x => x.id === existing.id ? next : x))
    return { created: false, candidate: next }
  }

  const candidate: Candidate = {
    ...c,
    id: crypto.randomUUID(),
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  }
  persist([...all, candidate])
  return { created: true, candidate }
}
