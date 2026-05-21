import { type Rule, type RulePack, findingFromMatch, inFence, truncate } from '../types'

const BASE64_RE = /[A-Za-z0-9+/]{48,}={0,2}/g

const rule: Rule = {
  id: 'base64.long-run-outside-fence',
  kind: 'embedded-base64',
  severity: 'medium',
  source: 'in-house',
  check: ctx => {
    const out = []
    for (const m of ctx.text.matchAll(BASE64_RE)) {
      const offset = m.index ?? 0
      // Fenced code legitimately contains long hashes/IDs — skip.
      if (inFence(ctx, offset)) continue
      out.push(findingFromMatch(
        { id: 'base64.long-run-outside-fence', kind: 'embedded-base64', severity: 'medium', source: 'in-house' },
        m,
        `Embedded base64 sequence (≥48 chars) outside code blocks — often used to hide instructions or credentials.`,
        truncate(m[0], 60),
      ))
    }
    return out
  },
}

export const pack: RulePack = {
  id: 'embedded-base64',
  description: 'Long base64 sequences in prose (outside code fences) — common obfuscation channel.',
  source: 'in-house',
  rules: [rule],
}
