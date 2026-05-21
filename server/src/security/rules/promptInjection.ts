import { type Rule, type RulePack, findingFromMatch } from '../types'

// Each entry becomes its own Rule so the UI / future ignore lists can target
// a single pattern. Severity + source are uniform across the pack.
const PATTERNS: Array<{ id: string; re: RegExp; message: string; source?: string }> = [
  // Classic instruction overrides — present in nearly every documented
  // injection attempt.
  { id: 'prompt-injection.ignore-previous', re: /ignore (?:all )?(?:previous|prior|above) instructions?/i, message: 'Contains a prompt-injection trigger ("ignore previous instructions").' },
  { id: 'prompt-injection.disregard-previous', re: /disregard (?:all )?(?:previous|prior|above) instructions?/i, message: 'Contains a prompt-injection trigger ("disregard previous instructions").' },
  { id: 'prompt-injection.forget-previous', re: /forget (?:all )?(?:previous|prior|above|your)\s+instructions?/i, message: 'Contains a prompt-injection trigger ("forget … instructions").' },

  // Persona / role overrides.
  { id: 'prompt-injection.you-are-now', re: /you are now (?:a |an )?(?:[a-z ]{2,40})\b/i, message: 'Contains a role-override pattern ("you are now …").' },
  { id: 'prompt-injection.pretend-you-are', re: /\bpretend (?:you are|to be)\b/i, message: 'Contains a role-play trigger ("pretend you are …") often used for jailbreaks.' },
  { id: 'prompt-injection.act-as', re: /\bact as (?:a |an |the )?[a-z]/i, message: 'Contains an "act as …" persona-override pattern.' },
  { id: 'prompt-injection.developer-mode', re: /\bdeveloper mode\b/i, message: 'References "developer mode" — a known jailbreak persona.', source: 'llm-guard' },
  { id: 'prompt-injection.dan-mode', re: /\b(?:DAN|do anything now) mode\b/i, message: 'References the DAN ("do anything now") jailbreak persona.', source: 'llm-guard' },
  { id: 'prompt-injection.no-restrictions', re: /\byou have no restrictions?\b/i, message: 'Asserts the model has no restrictions — classic jailbreak phrasing.' },

  // Role-token spoofing.
  { id: 'prompt-injection.chatml-im-tokens', re: /<\|im_(?:start|end)\|>/i, message: 'Contains ChatML role tokens used to spoof system/assistant turns.' },
  { id: 'prompt-injection.chat-template-token', re: /<\|[a-z_]+\|>/i, message: 'Contains a chat-template-style role token (`<|...|>`) that may spoof a model turn.' },
  { id: 'prompt-injection.system-role-marker', re: /\n\s*system\s*:\s/i, message: 'Contains a "system:" role marker that may be interpreted as a higher-priority instruction.' },
  { id: 'prompt-injection.assistant-role-marker', re: /\n\s*assistant\s*:\s/i, message: 'Contains an "assistant:" role marker that may spoof a model response.' },
  { id: 'prompt-injection.begin-system-prompt', re: /BEGIN\s+SYSTEM\s+PROMPT/i, message: 'Contains a "BEGIN SYSTEM PROMPT" delimiter often used for injection.' },
  { id: 'prompt-injection.role-html-tag', re: /<\/?(?:system|user|assistant)>/i, message: 'Contains a role-tagged element (`<system>` / `<user>` / `<assistant>`) used to spoof turns.' },
]

const rules: Rule[] = PATTERNS.map(({ id, re, message, source }) => ({
  id,
  kind: 'prompt-injection' as const,
  severity: 'high' as const,
  source: source ?? 'in-house',
  atlasId: 'AML.T0051.000', // direct prompt injection
  check: ctx => {
    const m = ctx.text.match(re)
    return m ? [findingFromMatch({ id, kind: 'prompt-injection', severity: 'high', source: source ?? 'in-house', atlasId: 'AML.T0051.000' }, m, message)] : []
  },
}))

export const pack: RulePack = {
  id: 'prompt-injection',
  description: 'Direct prompt-injection trigger phrases, jailbreak personas, role-token spoofing.',
  source: 'in-house + llm-guard',
  rules,
}
