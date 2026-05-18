import os from 'os'
import path from 'path'
import type { Bundle, BundleTarget, BundleScope } from './types'

// Where the trigger block is injected (the "top-level MD") and where the map
// file is written. Map files are placed in a sibling super-router/ dir so the
// relative pointer from the trigger block is short and obvious.
export interface ResolvedPaths {
  topFile: string
  mapFile: string
  mapRelative: string
}

function claudeGlobalRoot(): string {
  return path.join(os.homedir(), '.claude')
}

function cursorGlobalRoot(): string {
  return path.join(os.homedir(), '.cursor')
}

export function resolvePaths(target: BundleTarget, scope: BundleScope, slug: string): ResolvedPaths {
  if (target === 'claude') {
    if (scope.kind === 'global') {
      const root = claudeGlobalRoot()
      return {
        topFile: path.join(root, 'CLAUDE.md'),
        mapFile: path.join(root, 'super-router', `${slug}.md`),
        mapRelative: `./super-router/${slug}.md`,
      }
    }
    return {
      topFile: path.join(scope.path, 'CLAUDE.md'),
      mapFile: path.join(scope.path, '.claude', 'super-router', `${slug}.md`),
      mapRelative: `./.claude/super-router/${slug}.md`,
    }
  }

  // Cursor — this user's convention (and Cursor's own behavior) is to read
  // CLAUDE.md too, so we write the trigger block there and put the map files
  // in a Cursor-scoped super-router/ dir to avoid colliding with Claude's.
  if (scope.kind === 'global') {
    const root = cursorGlobalRoot()
    return {
      topFile: path.join(root, 'CLAUDE.md'),
      mapFile: path.join(root, 'super-router', `${slug}.md`),
      mapRelative: `./super-router/${slug}.md`,
    }
  }
  return {
    topFile: path.join(scope.path, 'CLAUDE.md'),
    mapFile: path.join(scope.path, '.cursor', 'super-router', `${slug}.md`),
    mapRelative: `./.cursor/super-router/${slug}.md`,
  }
}

export function resolveBundlePaths(b: Bundle): ResolvedPaths {
  return resolvePaths(b.target, b.scope, b.slug)
}
