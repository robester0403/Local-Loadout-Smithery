import fs from 'fs'

export interface FrontmatterResult {
  meta: Record<string, unknown>
  body: string
  raw: string
}

export function parseFrontmatter(filePath: string): FrontmatterResult {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return { meta: {}, body: '', raw: '' }
  }

  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { meta: {}, body: raw, raw }

  const meta: Record<string, unknown> = {}
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    if (!key) continue
    let value: unknown = line.slice(idx + 1).trim()
    if (typeof value === 'string') {
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      } else if (value === 'true') {
        value = true
      } else if (value === 'false') {
        value = false
      }
    }
    meta[key] = value
  }

  // Normalize version: if top-level `version` is absent but there's an
  // indented `version` key under a `metadata:` block, the trim-based parser
  // already picks it up. No extra step needed.

  return { meta, body: match[2], raw }
}
