import { describe, it, expect } from 'vitest'
import {
  diffSnapshots,
  identifierToName,
  rollupEvents,
  type CursorActivationEvent,
  type CursorRecentSnapshot,
} from '../cursor/recent'

const T0 = 1_700_000_000_000
const T1 = T0 + 30_000

function snap(partial: Partial<CursorRecentSnapshot>): CursorRecentSnapshot {
  return {
    observedAt: T0,
    skills: [],
    commands: [],
    subagents: [],
    ...partial,
  }
}

describe('identifierToName', () => {
  it('strips /SKILL.md from skill paths', () => {
    expect(identifierToName('foo/SKILL.md', 'skill')).toBe('foo')
  })
  it('handles nested skill paths', () => {
    expect(identifierToName('a/b/foo/SKILL.md', 'skill')).toBe('foo')
  })
  it('strips .md from command basenames', () => {
    expect(identifierToName('kibana/document.md', 'command')).toBe('document')
  })
  it('passes subagent identifier through', () => {
    expect(identifierToName('kb-evaluator', 'subagent')).toBe('kb-evaluator')
  })
})

describe('diffSnapshots', () => {
  it('returns empty for null prev and empty next', () => {
    expect(diffSnapshots(null, snap({}))).toEqual([])
  })

  it('treats every entry as new on first observation', () => {
    const next = snap({
      observedAt: T1,
      skills: ['a/SKILL.md', 'b/SKILL.md'],
    })
    const events = diffSnapshots(null, next)
    expect(events).toHaveLength(2)
    expect(events.map(e => e.name)).toEqual(['a', 'b'])
    expect(events.every(e => e.observedAt === T1)).toBe(true)
  })

  it('detects new entries appearing at the top', () => {
    const prev = snap({ skills: ['a/SKILL.md', 'b/SKILL.md'] })
    const next = snap({
      observedAt: T1,
      skills: ['c/SKILL.md', 'a/SKILL.md', 'b/SKILL.md'],
    })
    const events = diffSnapshots(prev, next)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ name: 'c', kind: 'skill', observedAt: T1 })
  })

  it('detects items moving up (lower index) as activations', () => {
    const prev = snap({ skills: ['a/SKILL.md', 'b/SKILL.md', 'c/SKILL.md'] })
    const next = snap({
      observedAt: T1,
      skills: ['c/SKILL.md', 'a/SKILL.md', 'b/SKILL.md'],
    })
    const events = diffSnapshots(prev, next)
    // 'c' moved from index 2 to index 0 — activation. 'a' and 'b' moved
    // down (higher index) and don't count.
    expect(events.map(e => e.name)).toEqual(['c'])
  })

  it('does NOT generate events for items that stayed in place', () => {
    const prev = snap({ skills: ['a/SKILL.md', 'b/SKILL.md'] })
    const next = snap({ observedAt: T1, skills: ['a/SKILL.md', 'b/SKILL.md'] })
    expect(diffSnapshots(prev, next)).toEqual([])
  })

  it('does NOT detect re-activation of the position-0 item (known limitation)', () => {
    // 'a' at top before and after — we have no way to know it was re-used.
    const prev = snap({ skills: ['a/SKILL.md', 'b/SKILL.md'] })
    const next = snap({ observedAt: T1, skills: ['a/SKILL.md', 'b/SKILL.md'] })
    expect(diffSnapshots(prev, next)).toEqual([])
  })

  it('tracks all three artifact kinds independently', () => {
    const prev = snap({})
    const next = snap({
      observedAt: T1,
      skills: ['s1/SKILL.md'],
      commands: ['cmd.md'],
      subagents: ['sa1'],
    })
    const events = diffSnapshots(prev, next)
    expect(events.map(e => `${e.kind}:${e.name}`).sort()).toEqual([
      'command:cmd',
      'skill:s1',
      'subagent:sa1',
    ])
  })
})

describe('rollupEvents', () => {
  it('returns hasData=false for empty input', () => {
    const r = rollupEvents([])
    expect(r.hasData).toBe(false)
    expect(r.totalEvents).toBe(0)
    expect(r.items).toEqual([])
  })

  it('aggregates by (kind, name) with first/last timestamps', () => {
    const events: CursorActivationEvent[] = [
      { name: 'foo', kind: 'skill', observedAt: T0 },
      { name: 'foo', kind: 'skill', observedAt: T1 },
      { name: 'bar', kind: 'skill', observedAt: T0 + 10 },
    ]
    const r = rollupEvents(events)
    expect(r.hasData).toBe(true)
    expect(r.totalEvents).toBe(3)
    expect(r.trackingSince).toBe(T0)
    const foo = r.items.find(i => i.name === 'foo')!
    expect(foo.count).toBe(2)
    expect(foo.firstSeen).toBe(T0)
    expect(foo.lastSeen).toBe(T1)
  })

  it('does NOT collide skill and command of the same name', () => {
    // A skill 'morning-plan' and a command 'morning-plan' are distinct
    // artifacts; rollup keys on (kind, name).
    const events: CursorActivationEvent[] = [
      { name: 'morning-plan', kind: 'skill', observedAt: T0 },
      { name: 'morning-plan', kind: 'command', observedAt: T1 },
    ]
    const r = rollupEvents(events)
    expect(r.items).toHaveLength(2)
  })

  it('sorts by count desc, then lastSeen desc', () => {
    const events: CursorActivationEvent[] = [
      { name: 'rare', kind: 'skill', observedAt: T1 + 1000 },
      { name: 'frequent', kind: 'skill', observedAt: T0 },
      { name: 'frequent', kind: 'skill', observedAt: T0 + 100 },
    ]
    const r = rollupEvents(events)
    expect(r.items[0].name).toBe('frequent')
    expect(r.items[1].name).toBe('rare')
  })
})
