import type { Skill } from './types'

export async function fetchInventory(): Promise<Skill[]> {
  const res = await fetch('/api/inventory')
  if (!res.ok) throw new Error(`Server returned ${res.status}`)
  const data = await res.json() as { skills: Skill[] }
  return data.skills
}

export async function openSkill(id: string): Promise<void> {
  await fetch(`/api/skills/${encodeURIComponent(id)}/open`, { method: 'POST' })
}
