import { type Rule, type RulePack, findingFromMatch } from '../types'

// XSS vectors against OUR rendering — the drawer marks skill bodies as HTML
// via `marked`, so a hostile `<script>` tag fires in our UI, not just in the
// agent's context. Severity high because the impact lands on us.
const PATTERNS: Array<{ id: string; re: RegExp; message: string }> = [
  { id: 'html.script-tag', re: /<script\b[^>]*>/i, message: 'Contains a `<script>` tag — XSS vector when the body is rendered in HTML.' },
  { id: 'html.iframe-tag', re: /<iframe\b[^>]*>/i, message: 'Contains an `<iframe>` tag — can embed remote content into rendered views.' },
  { id: 'html.object-tag', re: /<object\b[^>]*>/i, message: 'Contains an `<object>` tag — can embed remote content into rendered views.' },
  { id: 'html.embed-tag', re: /<embed\b[^>]*>/i, message: 'Contains an `<embed>` tag — can embed remote content into rendered views.' },
  { id: 'html.inline-event-handler', re: /\bon(?:click|load|error|mouseover|focus)\s*=/i, message: 'Contains an inline event handler (`onclick=`, `onerror=`, …) — XSS vector.' },
  { id: 'html.javascript-url', re: /\bjavascript:\s*[a-z]/i, message: 'Contains a `javascript:` URL — XSS vector in rendered links.' },
]

const rules: Rule[] = PATTERNS.map(({ id, re, message }) => ({
  id,
  kind: 'html-injection' as const,
  severity: 'high' as const,
  source: 'OWASP XSS cheat sheet',
  check: ctx => {
    const m = ctx.text.match(re)
    return m ? [findingFromMatch({ id, kind: 'html-injection', severity: 'high', source: 'OWASP XSS cheat sheet' }, m, message)] : []
  },
}))

export const pack: RulePack = {
  id: 'html-injection',
  description: 'HTML elements that execute or embed external content when the body is rendered to HTML in our UI.',
  source: 'OWASP XSS cheat sheet',
  rules,
}
