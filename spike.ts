import { detectActivations, ClaudeCodeActivationDetector } from './server/src/usage/activation'
import { discoverAllSkills } from './server/src/scanner/index'
import fs from 'fs'
import path from 'path'
import os from 'os'

const skills = discoverAllSkills().map(s => ({ name: s.name, bodyTokens: s.bodyTokens }))
console.log('Skills discovered:', skills.length)

// Look at the delta distribution in real sessions
const home = os.homedir()

function listDir(dir: string): string[] {
  try { return fs.readdirSync(dir) } catch { return [] }
}
function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory() } catch { return false } }

const since = new Date(Date.now() - 7 * 86400_000)

// Collect all cc deltas from real sessions
const allDeltas: number[] = []
const allMatchedSingleDeltas: Array<{ delta: number, skill: string, bodyTokens: number, ratio: number }> = []
const allMatchedPairDeltas: Array<{ delta: number, s1: string, s2: string }> = []
const slashCommandActivations: Array<{ skill: string, delta: number, bodyTokens: number }> = []

for (const entry of listDir(home)) {
  if (!entry.startsWith('.claude')) continue
  const accountDir = path.join(home, entry)
  if (!isDir(accountDir)) continue
  for (const projHash of listDir(path.join(accountDir, 'projects'))) {
    const projDir = path.join(accountDir, 'projects', projHash)
    if (!isDir(projDir)) continue
    for (const file of listDir(projDir)) {
      if (!file.endsWith('.jsonl')) continue
      const filePath = path.join(projDir, file)
      let raw: string
      try { raw = fs.readFileSync(filePath, 'utf-8') } catch { continue }

      let pendingSlashSkill: string | undefined
      for (const line of raw.split('\n')) {
        const t = line.trim()
        if (!t) continue
        let obj: Record<string, unknown>
        try { obj = JSON.parse(t) as Record<string, unknown> } catch { continue }

        if (obj['type'] === 'user') {
          const content = (obj['message'] as any)?.content
          const contentStr = typeof content === 'string' ? content : ''
          const m = contentStr.match(/<command-message>([^<]+)<\/command-message>/)
          pendingSlashSkill = m ? m[1].trim() : undefined
          continue
        }
        if (obj['type'] !== 'assistant') { pendingSlashSkill = undefined; continue }

        const ts = obj['timestamp'] as string ?? ''
        if (ts && new Date(ts) < since) { pendingSlashSkill = undefined; continue }

        const msg = obj['message'] as any
        if (!msg || msg['role'] !== 'assistant') { pendingSlashSkill = undefined; continue }

        const cc: number = msg?.usage?.cache_creation_input_tokens ?? 0
        if (cc > 200) {
          allDeltas.push(cc)

          const candidates = skills
          const singles = candidates.filter(s => Math.abs(s.bodyTokens - cc) / cc <= 0.15)
          if (singles.length === 1) {
            allMatchedSingleDeltas.push({ delta: cc, skill: singles[0].name, bodyTokens: singles[0].bodyTokens, ratio: cc / singles[0].bodyTokens })
            if (pendingSlashSkill === singles[0].name) {
              slashCommandActivations.push({ skill: singles[0].name, delta: cc, bodyTokens: singles[0].bodyTokens })
            }
          } else if (singles.length === 0) {
            // check pairs
            let foundPair = false
            outer: for (let i = 0; i < candidates.length; i++) {
              for (let j = i + 1; j < candidates.length; j++) {
                const sum = candidates[i].bodyTokens + candidates[j].bodyTokens
                if (Math.abs(sum - cc) / cc <= 0.15) {
                  allMatchedPairDeltas.push({ delta: cc, s1: candidates[i].name, s2: candidates[j].name })
                  foundPair = true
                  break outer
                }
              }
            }
          }
        }
        pendingSlashSkill = undefined
      }
    }
  }
}

console.log('\n=== Delta distribution (last 7d) ===')
console.log('Total cc events > 200 tokens:', allDeltas.length)
console.log('Matched single skill:', allMatchedSingleDeltas.length, `(${(100*allMatchedSingleDeltas.length/allDeltas.length).toFixed(1)}%)`)
console.log('Matched pair:', allMatchedPairDeltas.length, `(${(100*allMatchedPairDeltas.length/allDeltas.length).toFixed(1)}%)`)
console.log('Unmatched:', allDeltas.length - allMatchedSingleDeltas.length - allMatchedPairDeltas.length)

console.log('\n=== Single-match events (sample) ===')
allMatchedSingleDeltas.slice(0, 10).forEach(e =>
  console.log(`  ${e.skill}: delta=${e.delta} body=${e.bodyTokens} ratio=${e.ratio.toFixed(2)}`)
)

console.log('\n=== Single matches confirmed by slash command ===')
console.log('Count:', slashCommandActivations.length)
slashCommandActivations.slice(0, 5).forEach(e =>
  console.log(`  ${e.skill}: delta=${e.delta} body=${e.bodyTokens}`)
)

console.log('\n=== Pair-match events (sample) ===')
allMatchedPairDeltas.slice(0, 10).forEach(e =>
  console.log(`  ${e.s1}+${e.s2}: delta=${e.delta}`)
)

console.log('\n=== Delta size histogram ===')
const buckets = [200, 500, 1000, 2000, 5000, 10000, 20000, Infinity]
const counts = new Array(buckets.length).fill(0)
for (const d of allDeltas) {
  for (let i = 0; i < buckets.length; i++) {
    if (d < buckets[i]) { counts[i]++; break }
  }
}
buckets.forEach((b, i) => {
  const label = i === 0 ? `200-500` : i === buckets.length-1 ? `>${buckets[i-1]}` : `${buckets[i-1]}-${b}`
  console.log(`  ${label}: ${counts[i]}`)
})

// Show skill body size distribution
console.log('\n=== Skill body token sizes ===')
const sorted = [...skills].sort((a, b) => b.bodyTokens - a.bodyTokens)
sorted.slice(0, 15).forEach(s => console.log(`  ${s.name}: ${s.bodyTokens}`))
