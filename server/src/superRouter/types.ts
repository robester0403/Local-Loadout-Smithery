export type BundleTarget = 'claude' | 'cursor'

export type BundleScope =
  | { kind: 'global' }
  | { kind: 'project'; path: string }

// A skill entry inside a bundle. `description` is the user-authored
// "when to use this in this bundle" copy. Required for items whose source
// has no description (notably commands); optional otherwise (acts as an
// override of the source frontmatter description when present).
export interface BundleSkillEntry {
  id: string
  description?: string
}

export interface Bundle {
  id: string
  name: string
  slug: string
  target: BundleTarget
  scope: BundleScope
  trigger: string
  skills: BundleSkillEntry[]
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface BundleInput {
  name: string
  target: BundleTarget
  scope: BundleScope
  trigger: string
  skills: BundleSkillEntry[]
}
