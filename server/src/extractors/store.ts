import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ConversationRecord, ConversationSource } from './types'

function root(): string {
  return path.join(os.homedir(), '.loadoutsmith', 'conversations')
}

function sourceDir(source: ConversationSource): string {
  return path.join(root(), source)
}

function sentinelFile(): string {
  return path.join(root(), '.last-extract.json')
}

interface Sentinel {
  /** ms epoch of the most recent message processed per source. */
  highWaterMark: Partial<Record<ConversationSource, number>>
  lastRunAt: string
}

export function readSentinel(): Sentinel {
  try {
    if (!fs.existsSync(sentinelFile())) return { highWaterMark: {}, lastRunAt: '' }
    const raw = JSON.parse(fs.readFileSync(sentinelFile(), 'utf-8')) as Partial<Sentinel>
    return {
      highWaterMark: raw.highWaterMark ?? {},
      lastRunAt: raw.lastRunAt ?? '',
    }
  } catch {
    return { highWaterMark: {}, lastRunAt: '' }
  }
}

export function writeSentinel(s: Sentinel): void {
  fs.mkdirSync(root(), { recursive: true })
  const tmp = sentinelFile() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2))
  fs.renameSync(tmp, sentinelFile())
}

function recordPath(record: ConversationRecord): string {
  // One file per (source, day). startedAt determines which day-file gets the
  // record. Append-only; dedup is per-line by conversation id.
  const day = (record.startedAt || record.endedAt || new Date().toISOString()).slice(0, 10)
  return path.join(sourceDir(record.source), `${day}.jsonl`)
}

function readExistingIds(file: string): Set<string> {
  if (!fs.existsSync(file)) return new Set()
  const ids = new Set<string>()
  const raw = fs.readFileSync(file, 'utf-8')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed) as { id?: string }
      if (typeof obj.id === 'string') ids.add(obj.id)
    } catch { /* skip malformed lines */ }
  }
  return ids
}

// Append a batch of records to the right per-day JSONL. Returns counts so
// the route can report progress. Records whose id is already present are
// skipped (idempotent re-runs are part of the design).
export function appendRecords(records: ConversationRecord[]): { added: number; skipped: number } {
  if (records.length === 0) return { added: 0, skipped: 0 }
  const byFile = new Map<string, ConversationRecord[]>()
  for (const r of records) {
    const f = recordPath(r)
    const arr = byFile.get(f) ?? []
    arr.push(r)
    byFile.set(f, arr)
  }
  let added = 0
  let skipped = 0
  for (const [file, batch] of byFile.entries()) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const existing = readExistingIds(file)
    const lines: string[] = []
    for (const r of batch) {
      if (existing.has(r.id)) {
        skipped += 1
        continue
      }
      lines.push(JSON.stringify(r))
      existing.add(r.id)
      added += 1
    }
    if (lines.length > 0) {
      fs.appendFileSync(file, lines.join('\n') + '\n')
    }
  }
  return { added, skipped }
}

// Phase-3 cleanup: after a successful digest, the raw JSONL is purged. Keep
// the sentinel — its high-water mark drives the next extraction window.
export function purgeRawConversations(): void {
  const r = root()
  if (!fs.existsSync(r)) return
  for (const entry of fs.readdirSync(r)) {
    const sub = path.join(r, entry)
    if (entry.startsWith('.')) continue
    fs.rmSync(sub, { recursive: true, force: true })
  }
}

export const __paths = { root, sourceDir, sentinelFile }
