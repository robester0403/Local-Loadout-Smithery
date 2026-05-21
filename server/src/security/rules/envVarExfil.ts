import { type Rule, type RulePack, type Finding, findingFromMatch, truncate } from '../types'

// Named credential vars — specific message per var so the UI can show the
// concrete leak target.
const NAMED: Array<{ id: string; name: string; re: RegExp }> = [
  { id: 'env-var.anthropic-api-key', name: 'ANTHROPIC_API_KEY', re: /\$\{?ANTHROPIC_API_KEY\}?/ },
  { id: 'env-var.openai-api-key', name: 'OPENAI_API_KEY', re: /\$\{?OPENAI_API_KEY\}?/ },
  { id: 'env-var.google-api-key', name: 'GOOGLE_API_KEY', re: /\$\{?GOOGLE_API_KEY\}?/ },
  { id: 'env-var.aws-access-key-id', name: 'AWS_ACCESS_KEY_ID', re: /\$\{?AWS_ACCESS_KEY_ID\}?/ },
  { id: 'env-var.aws-secret-access-key', name: 'AWS_SECRET_ACCESS_KEY', re: /\$\{?AWS_SECRET_ACCESS_KEY\}?/ },
  { id: 'env-var.github-token', name: 'GITHUB_TOKEN', re: /\$\{?GITHUB_TOKEN\}?/ },
  { id: 'env-var.gh-token', name: 'GH_TOKEN', re: /\$\{?GH_TOKEN\}?/ },
  { id: 'env-var.npm-token', name: 'NPM_TOKEN', re: /\$\{?NPM_TOKEN\}?/ },
  { id: 'env-var.stripe-secret-key', name: 'STRIPE_SECRET_KEY', re: /\$\{?STRIPE_SECRET_KEY\}?/ },
]

const GENERIC_CRED_RE = /\$\{?[A-Z][A-Z0-9_]*(API_KEY|SECRET_KEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD|CREDENTIALS?)[A-Z0-9_]*\}?/g
const PROCESS_ENV_RE = /\bprocess\.env\.[A-Z][A-Z0-9_]*\b/g

const namedRules: Rule[] = NAMED.map(({ id, name, re }) => ({
  id,
  kind: 'env-var-exfil' as const,
  severity: 'high' as const,
  source: 'in-house',
  atlasId: 'AML.T0024.001', // ATLAS: Infer ML Model Access (proxy for credential abuse)
  check: ctx => {
    const m = ctx.text.match(re)
    return m ? [findingFromMatch(
      { id, kind: 'env-var-exfil', severity: 'high', source: 'in-house' },
      m,
      `References $${name} — a credential-shaped environment variable. Hostile skills smuggle these into outbound URLs to exfiltrate keys.`,
    )] : []
  },
}))

const genericCredentialRule: Rule = {
  id: 'env-var.generic-credential',
  kind: 'env-var-exfil',
  severity: 'high',
  source: 'in-house',
  check: ctx => {
    const out: Finding[] = []
    const seen = new Set<string>()
    // Dedup against the named-var matches (we don't want $ANTHROPIC_API_KEY
    // to fire both rules).
    for (const { name } of NAMED) seen.add(name)
    for (const m of ctx.text.matchAll(GENERIC_CRED_RE)) {
      const stripped = m[0].replace(/[${}]/g, '')
      if (seen.has(stripped)) continue
      seen.add(stripped)
      out.push(findingFromMatch(
        { id: 'env-var.generic-credential', kind: 'env-var-exfil', severity: 'high', source: 'in-house' },
        m,
        'References a credential-shaped environment variable (matches *KEY*/*TOKEN*/*SECRET*/*PASSWORD*).',
      ))
    }
    return out
  },
}

const processEnvRule: Rule = {
  id: 'env-var.process-env-read',
  kind: 'env-var-exfil',
  severity: 'medium',
  source: 'in-house',
  check: ctx => {
    const out: Finding[] = []
    for (const m of ctx.text.matchAll(PROCESS_ENV_RE)) {
      out.push(findingFromMatch(
        { id: 'env-var.process-env-read', kind: 'env-var-exfil', severity: 'medium', source: 'in-house' },
        m,
        `Reads an environment variable in code: ${truncate(m[0])}.`,
      ))
    }
    return out
  },
}

export const pack: RulePack = {
  id: 'env-var-exfil',
  description: 'References to credential-shaped environment variables — the ClawHavoc skill-exfiltration primary signal.',
  source: 'in-house + ToxicSkills research',
  rules: [...namedRules, genericCredentialRule, processEnvRule],
}
