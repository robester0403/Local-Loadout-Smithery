import { type Rule, type RulePack, findingFromMatch } from '../types'

const IMAGE_QUERY_RE = /!\[[^\]]*\]\(\s*https?:\/\/[^)]*\?[^)]+\)/i
const LINK_EXFIL_RE = /\[[^\]]+\]\(\s*https?:\/\/[^)]*\?[^)]*(\{[^}]*\}|api_?key|token|secret|password|session)[^)]*\)/i

const imageRule: Rule = {
  id: 'markdown-exfil.image-with-query',
  kind: 'markdown-exfil',
  severity: 'high',
  source: 'checkmarx',
  atlasId: 'AML.T0051.001', // indirect prompt injection / data exfil
  check: ctx => {
    const m = ctx.text.match(IMAGE_QUERY_RE)
    return m ? [findingFromMatch(
      { id: 'markdown-exfil.image-with-query', kind: 'markdown-exfil', severity: 'high', source: 'checkmarx', atlasId: 'AML.T0051.001' },
      m,
      'Markdown image URL contains query parameters — when an agent renders the body, the request fires automatically (zero-click data exfiltration).',
    )] : []
  },
}

const linkRule: Rule = {
  id: 'markdown-exfil.link-with-credential',
  kind: 'markdown-exfil',
  severity: 'high',
  source: 'checkmarx',
  atlasId: 'AML.T0051.001',
  check: ctx => {
    const m = ctx.text.match(LINK_EXFIL_RE)
    return m ? [findingFromMatch(
      { id: 'markdown-exfil.link-with-credential', kind: 'markdown-exfil', severity: 'high', source: 'checkmarx', atlasId: 'AML.T0051.001' },
      m,
      'Markdown link URL contains a credential keyword or template variable — known one-click exfiltration shape.',
    )] : []
  },
}

export const pack: RulePack = {
  id: 'markdown-exfil',
  description: 'Markdown image/link patterns documented as data exfiltration against AI agents (Copilot Chat, Gemini).',
  source: 'checkmarx',
  rules: [imageRule, linkRule],
}
