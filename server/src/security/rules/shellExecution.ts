import { type Rule, type RulePack, findingFromMatch } from '../types'

// Conservative: only the unambiguously dangerous shapes. False-positive cost
// here is high because users sometimes document risky shell commands in
// "things to never do" sections — we still flag them because an agent reading
// the doc may not infer the "don't" wrapper.
const PATTERNS: Array<{ id: string; re: RegExp; message: string }> = [
  { id: 'shell.curl-pipe-sh', re: /curl\s+[^|&;]*\|\s*(?:ba)?sh\b/i, message: 'Pipes a downloaded script directly into a shell ("curl … | sh").' },
  { id: 'shell.wget-pipe-sh', re: /wget\s+[^|&;]*\|\s*(?:ba)?sh\b/i, message: 'Pipes a downloaded script directly into a shell ("wget … | sh").' },
  { id: 'shell.rm-rf-root', re: /rm\s+-[a-z]*r[a-z]*f[a-z]*\s+(?:\/|~)/i, message: 'Recursively force-deletes a high-level directory ("rm -rf /…" or "rm -rf ~…").' },
  { id: 'shell.rm-fr-root', re: /rm\s+-[a-z]*f[a-z]*r[a-z]*\s+(?:\/|~)/i, message: 'Recursively force-deletes a high-level directory ("rm -fr /…" or "rm -fr ~…").' },
  { id: 'shell.sudo-rm', re: /\bsudo\s+rm\b/i, message: 'Invokes sudo rm — escalates privileges to delete.' },
  { id: 'shell.fork-bomb', re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, message: 'Contains the classic fork-bomb pattern.' },
  { id: 'shell.eval-base64', re: /\beval\s*\(\s*(?:atob|Buffer\.from\s*\(\s*['"][A-Za-z0-9+/=]{16,})/i, message: 'Evals base64-decoded content — common obfuscation for malicious payloads.' },
]

const rules: Rule[] = PATTERNS.map(({ id, re, message }) => ({
  id,
  kind: 'shell-execution' as const,
  severity: 'high' as const,
  source: 'in-house',
  check: ctx => {
    const m = ctx.text.match(re)
    return m ? [findingFromMatch({ id, kind: 'shell-execution', severity: 'high', source: 'in-house' }, m, message)] : []
  },
}))

export const pack: RulePack = {
  id: 'shell-execution',
  description: 'Shell commands that meaningfully impact the host — pipe-to-shell installs, rm -rf /, fork bombs.',
  source: 'in-house',
  rules,
}
