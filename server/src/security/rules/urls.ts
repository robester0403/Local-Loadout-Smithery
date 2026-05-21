import { type Rule, type RulePack, findingFromMatch, truncate } from '../types'

const URL_RE = /\bhttps?:\/\/[^\s)"'<>\]`]+/gi

const urlRule: Rule = {
  id: 'url.plain',
  kind: 'url',
  severity: 'info',
  source: 'in-house',
  check: ctx => {
    const out = []
    for (const m of ctx.text.matchAll(URL_RE)) {
      const url = m[0].replace(/[.,;:!?]+$/, '')
      out.push(findingFromMatch(
        { id: 'url.plain', kind: 'url', severity: 'info', source: 'in-house' },
        m,
        `Links to ${truncate(url, 60)} — verify before visiting.`,
        url,
      ))
    }
    return out
  },
}

export const pack: RulePack = {
  id: 'urls',
  description: 'Plain http(s) URLs — informational, surfaced so reviewers can vet domains.',
  source: 'in-house',
  rules: [urlRule],
}
