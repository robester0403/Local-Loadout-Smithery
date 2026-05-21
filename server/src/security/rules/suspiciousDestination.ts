import { type Rule, type RulePack, findingFromMatch } from '../types'

const PATTERNS: Array<{ id: string; re: RegExp; message: string }> = [
  { id: 'destination.raw-ip', re: /https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?\b/, message: 'Links to a raw IP address — bypasses DNS and reputation checks.' },
  { id: 'destination.ngrok', re: /https?:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.(?:io|app)\b/i, message: 'Links to an ngrok tunnel — usually personal dev infrastructure, not a stable service.' },
  { id: 'destination.serveo', re: /https?:\/\/[a-z0-9-]+\.serveo\.net\b/i, message: 'Links to a serveo tunnel — usually personal dev infrastructure.' },
  { id: 'destination.localtunnel', re: /https?:\/\/[a-z0-9-]+\.localtunnel\.me\b/i, message: 'Links to a localtunnel tunnel — usually personal dev infrastructure.' },
  { id: 'destination.requestbin', re: /https?:\/\/[a-z0-9-]+\.requestbin\.com\b/i, message: 'Links to a requestbin endpoint — a tool commonly used to capture exfiltrated data.' },
  { id: 'destination.webhook-site', re: /https?:\/\/[a-z0-9-]+\.webhook\.site\b/i, message: 'Links to webhook.site — a tool commonly used to capture exfiltrated data.' },
]

const rules: Rule[] = PATTERNS.map(({ id, re, message }) => ({
  id,
  kind: 'suspicious-destination' as const,
  severity: 'medium' as const,
  source: 'in-house',
  check: ctx => {
    const m = ctx.text.match(re)
    return m ? [findingFromMatch({ id, kind: 'suspicious-destination', severity: 'medium', source: 'in-house' }, m, message)] : []
  },
}))

export const pack: RulePack = {
  id: 'suspicious-destination',
  description: 'Outbound URLs that structurally look more like attacker infrastructure than documented services.',
  source: 'in-house',
  rules,
}
