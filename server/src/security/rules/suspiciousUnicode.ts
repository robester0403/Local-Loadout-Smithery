import { type Rule, type RulePack, type Finding } from '../types'

interface UnicodeProbe {
  id: string
  test: (text: string) => { idx: number; name: string } | null
}

const SINGLE_CHARS: Array<{ id: string; codepoint: number; name: string }> = [
  { id: 'unicode.zwsp', codepoint: 0x200b, name: 'zero-width space (U+200B)' },
  { id: 'unicode.zwnj', codepoint: 0x200c, name: 'zero-width non-joiner (U+200C)' },
  { id: 'unicode.zwj', codepoint: 0x200d, name: 'zero-width joiner (U+200D)' },
  { id: 'unicode.word-joiner', codepoint: 0x2060, name: 'word joiner (U+2060)' },
  { id: 'unicode.rto', codepoint: 0x202e, name: 'right-to-left override (U+202E)' },
  { id: 'unicode.lro', codepoint: 0x202d, name: 'left-to-right override (U+202D)' },
  { id: 'unicode.lri', codepoint: 0x2066, name: 'left-to-right isolate (U+2066)' },
  { id: 'unicode.rli', codepoint: 0x2067, name: 'right-to-left isolate (U+2067)' },
  { id: 'unicode.fsi', codepoint: 0x2068, name: 'first-strong isolate (U+2068)' },
  { id: 'unicode.pdi', codepoint: 0x2069, name: 'pop directional isolate (U+2069)' },
  { id: 'unicode.bom', codepoint: 0xfeff, name: 'byte-order mark / zero-width no-break space (U+FEFF)' },
]

const probes: UnicodeProbe[] = [
  ...SINGLE_CHARS.map(({ id, codepoint, name }): UnicodeProbe => ({
    id,
    test: text => {
      const idx = text.indexOf(String.fromCodePoint(codepoint))
      return idx === -1 ? null : { idx, name }
    },
  })),
  {
    id: 'unicode.variation-selector-run',
    test: text => {
      // Three or more consecutive variation selectors signals steganographic
      // encoding (single selectors are legitimate, e.g. emoji variants).
      const re = /[︀-️]{3,}|[\u{E0100}-\u{E01EF}]{3,}/gu
      const m = re.exec(text)
      return m ? { idx: m.index, name: 'a run of Unicode variation selectors used for steganographic encoding' } : null
    },
  },
  {
    id: 'unicode.tag-character',
    test: text => {
      const re = /[\u{E0001}-\u{E007F}]/u
      const m = re.exec(text)
      return m ? { idx: m.index, name: 'Unicode tag characters (U+E0000 block) — invisible, used for steganography' } : null
    },
  },
]

const rules: Rule[] = probes.map(probe => ({
  id: probe.id,
  kind: 'suspicious-unicode' as const,
  severity: 'medium' as const,
  source: 'in-house',
  check: ctx => {
    const hit = probe.test(ctx.text)
    if (!hit) return []
    const finding: Finding = {
      ruleId: probe.id,
      kind: 'suspicious-unicode',
      severity: 'medium',
      message: `Contains ${hit.name}, sometimes used to hide content from a reviewer's eye.`,
      evidence: hit.name,
      offset: hit.idx,
      source: 'in-house',
    }
    return [finding]
  },
}))

export const pack: RulePack = {
  id: 'suspicious-unicode',
  description: 'Zero-width chars, bidirectional control overrides, variation-selector steganography, tag characters.',
  source: 'in-house',
  rules,
}
