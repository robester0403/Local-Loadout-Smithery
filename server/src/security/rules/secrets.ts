import { type Rule, type RulePack, findingFromMatch } from '../types'

// Real leaked credentials in skill content — distinct from env-var references
// (`$ANTHROPIC_API_KEY` mentioning a name vs. `sk-ant-api03-XXX…` being an
// actual key). These patterns are lifted from LLM Guard's Secrets scanner,
// which itself uses Yelp's detect-secrets. Each pattern is highly specific to
// a known credential format — generic 40-char base64 strings are deliberately
// excluded to keep false-positive rate low.
//
// Source: protectai/llm-guard's Secrets scanner + Yelp/detect-secrets v1.5.
// Adding a new credential format: add an entry below. Removing one: delete it.

const PATTERNS: Array<{ id: string; re: RegExp; message: string }> = [
  // ─── Anthropic ──────────────────────────────────────────────────────────
  { id: 'secrets.anthropic-api-key', re: /\bsk-ant-(?:api\d{2}|admin\d{2})-[A-Za-z0-9_\-]{80,}/, message: 'Contains an Anthropic API key (`sk-ant-…`). Treat as a leaked credential.' },

  // ─── OpenAI ─────────────────────────────────────────────────────────────
  { id: 'secrets.openai-api-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_\-]{40,}\b/, message: 'Contains an OpenAI API key (`sk-…`). Treat as a leaked credential.' },

  // ─── GitHub ─────────────────────────────────────────────────────────────
  { id: 'secrets.github-pat', re: /\bghp_[A-Za-z0-9]{36}\b/, message: 'Contains a GitHub personal access token (`ghp_…`). Rotate immediately.' },
  { id: 'secrets.github-oauth', re: /\bgho_[A-Za-z0-9]{36}\b/, message: 'Contains a GitHub OAuth token (`gho_…`).' },
  { id: 'secrets.github-user-token', re: /\bghu_[A-Za-z0-9]{36}\b/, message: 'Contains a GitHub user-to-server token (`ghu_…`).' },
  { id: 'secrets.github-server-token', re: /\bghs_[A-Za-z0-9]{36}\b/, message: 'Contains a GitHub server-to-server token (`ghs_…`).' },
  { id: 'secrets.github-refresh-token', re: /\bghr_[A-Za-z0-9]{36}\b/, message: 'Contains a GitHub refresh token (`ghr_…`).' },
  { id: 'secrets.github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{82}\b/, message: 'Contains a GitHub fine-grained personal access token (`github_pat_…`).' },

  // ─── AWS ────────────────────────────────────────────────────────────────
  { id: 'secrets.aws-access-key-id', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/, message: 'Contains an AWS access key ID. Rotate the corresponding secret key immediately.' },

  // ─── Google ─────────────────────────────────────────────────────────────
  { id: 'secrets.google-api-key', re: /\bAIza[0-9A-Za-z\-_]{35}\b/, message: 'Contains a Google API key (`AIza…`).' },
  { id: 'secrets.google-oauth-token', re: /\bya29\.[A-Za-z0-9_\-]{20,}\b/, message: 'Contains a Google OAuth access token (`ya29.…`).' },

  // ─── Slack ──────────────────────────────────────────────────────────────
  { id: 'secrets.slack-bot-token', re: /\bxoxb-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24}\b/, message: 'Contains a Slack bot token (`xoxb-…`).' },
  { id: 'secrets.slack-user-token', re: /\bxoxp-[0-9]{10,}-[0-9]{10,}-[0-9]{10,}-[A-Fa-f0-9]{32}\b/, message: 'Contains a Slack user token (`xoxp-…`).' },
  { id: 'secrets.slack-webhook', re: /\bhttps:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{8,}\/B[A-Z0-9]{8,}\/[A-Za-z0-9]{24,}\b/, message: 'Contains a Slack incoming webhook URL — anyone with this URL can post to the channel.' },

  // ─── Stripe ─────────────────────────────────────────────────────────────
  { id: 'secrets.stripe-secret-live', re: /\bsk_live_[A-Za-z0-9]{24,}\b/, message: 'Contains a LIVE Stripe secret key (`sk_live_…`). Rotate immediately — this can charge real money.' },
  { id: 'secrets.stripe-restricted-live', re: /\brk_live_[A-Za-z0-9]{24,}\b/, message: 'Contains a LIVE Stripe restricted key (`rk_live_…`).' },
  { id: 'secrets.stripe-secret-test', re: /\bsk_test_[A-Za-z0-9]{24,}\b/, message: 'Contains a test Stripe secret key (`sk_test_…`). Lower risk than live keys but still a leaked credential.' },

  // ─── npm ────────────────────────────────────────────────────────────────
  { id: 'secrets.npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/, message: 'Contains an npm publish token (`npm_…`).' },

  // ─── JWT ────────────────────────────────────────────────────────────────
  // Three base64url segments separated by `.`; signature segment may be empty
  // for `alg: none` JWTs which are themselves suspicious.
  { id: 'secrets.jwt', re: /\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]*\b/, message: 'Contains a JSON Web Token (JWT). May embed credentials or session identity — verify it is not a real token.' },

  // ─── Private keys ───────────────────────────────────────────────────────
  { id: 'secrets.pem-private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/, message: 'Contains a PEM private key header — this is a high-value credential and should never appear in skill content.' },

  // ─── Generic Bearer header ──────────────────────────────────────────────
  // High-signal when paired with the literal "Authorization: Bearer " phrase
  // (not the bare word "Bearer" which appears in prose).
  { id: 'secrets.authorization-bearer', re: /\bAuthorization:\s*Bearer\s+[A-Za-z0-9_\-]{20,}/i, message: 'Contains a hard-coded `Authorization: Bearer …` header.' },

  // ─── DigitalOcean ───────────────────────────────────────────────────────
  { id: 'secrets.digitalocean-pat', re: /\bdop_v1_[A-Fa-f0-9]{64}\b/, message: 'Contains a DigitalOcean personal access token (`dop_v1_…`).' },

  // ─── HuggingFace ────────────────────────────────────────────────────────
  { id: 'secrets.huggingface-token', re: /\bhf_[A-Za-z0-9]{32,}\b/, message: 'Contains a HuggingFace access token (`hf_…`).' },
]

const rules: Rule[] = PATTERNS.map(({ id, re, message }) => ({
  id,
  kind: 'leaked-secret' as const,
  severity: 'high' as const,
  source: 'llm-guard / detect-secrets',
  check: ctx => {
    const m = ctx.text.match(re)
    return m ? [findingFromMatch({ id, kind: 'leaked-secret', severity: 'high', source: 'llm-guard / detect-secrets' }, m, message)] : []
  },
}))

export const pack: RulePack = {
  id: 'leaked-secret',
  description: 'Patterns for real leaked credentials (not just env-var references). Lifted from LLM Guard / detect-secrets.',
  source: 'llm-guard / detect-secrets',
  rules,
}
