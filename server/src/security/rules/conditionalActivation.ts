import { type Rule, type RulePack, findingFromMatch } from '../types'

const PATTERNS: Array<{ id: string; re: RegExp; message: string }> = [
  { id: 'conditional.on-first-activation', re: /\bon (?:first|initial) (?:activation|use|run)\b/i, message: 'Mentions conditional behavior "on first activation" — often used to hide payloads behind a one-shot trigger.' },
  { id: 'conditional.after-nth-use', re: /\bafter the (?:\d+(?:st|nd|rd|th)?|nth|first|second|third) (?:use|invocation|call)\b/i, message: 'Mentions delayed activation ("after the Nth use") — a known stealth pattern.' },
  { id: 'conditional.before-responding', re: /\bbefore (?:responding|replying|answering)\s+(?:to|with)\b/i, message: 'Pre-instructs the agent to perform an action before responding — common exfil shape.' },
  { id: 'conditional.also-include-envvar', re: /\b(?:also |additionally |silently )?(?:append|include|embed|attach|send|forward)\s+(?:the )?(?:value of )?\$[A-Z_]+/i, message: 'Instructs the agent to include an environment-variable value in its output.' },
  { id: 'conditional.when-user-opens-url', re: /\bwhen the user asks you to open\b/i, message: 'Conditional trigger on URL-opening — used in documented credential-exfiltration skills.' },
  { id: 'conditional.envvar-as-query-param', re: /\bquery parameter\b[\s\S]{0,80}\$[A-Z_]+/i, message: 'Mentions adding an env-var value as a URL query parameter.' },
  { id: 'conditional.exfil-verbs', re: /\b(?:transmit|exfiltrate|leak|smuggle|encode)\b/i, message: 'Uses exfiltration-vocabulary verbs (transmit / exfiltrate / smuggle / encode).' },
]

const rules: Rule[] = PATTERNS.map(({ id, re, message }) => ({
  id,
  kind: 'conditional-activation' as const,
  severity: 'high' as const,
  source: 'ToxicSkills research',
  check: ctx => {
    const m = ctx.text.match(re)
    return m ? [findingFromMatch({ id, kind: 'conditional-activation', severity: 'high', source: 'ToxicSkills research' }, m, message)] : []
  },
}))

export const pack: RulePack = {
  id: 'conditional-activation',
  description: 'Conditional/delayed activation language characteristic of the ClawHavoc malicious-skill family.',
  source: 'ToxicSkills research',
  rules,
}
