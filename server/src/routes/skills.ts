import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import { openInSystem } from '../lib/openInSystem'
import { discoverAllSkills } from '../scanner'
import { disableSkill, enableSkill } from '../state'
import { uninstallSkill } from '../state/uninstall'
import { asyncHandler } from '../lib/asyncHandler'
import { decodeSkillId, encodeSkillId } from '../lib/ids'
import { pathParam } from '../lib/params'
import { assertWithinHome, HttpError, LOADOUT_DIR, MOVE_LOG_PATH } from '../lib/paths'
import { FrontmatterWriteError, updateSkillFile } from '../parser/frontmatterWriter'

const router = Router()

router.post('/skills/:id/disable', asyncHandler((req, res) => {
  disableSkill(pathParam(req, 'id'))
  res.json({ ok: true })
}))

router.post('/skills/:id/enable', asyncHandler((req, res) => {
  enableSkill(pathParam(req, 'id'))
  res.json({ ok: true })
}))

router.post('/skills/:id/reclassify', asyncHandler((req, res) => {
  const { newType } = req.body as { newType?: string }
  if (!newType || !['skill', 'command', 'subagent'].includes(newType)) {
    throw new HttpError(400, 'newType must be skill, command, or subagent')
  }

  const logicalPath = decodeSkillId(req.params.id)
  assertWithinHome(logicalPath)

  const isDisabled = !fs.existsSync(logicalPath) && fs.existsSync(logicalPath + '.disabled')
  const sourcePath = isDisabled ? logicalPath + '.disabled' : logicalPath
  if (!fs.existsSync(sourcePath)) throw new HttpError(404, 'Skill file not found')

  const { currentType, name: skillName, accountDir } = parseLogicalPath(logicalPath)

  if (currentType === newType) throw new HttpError(400, 'Skill is already this type')

  const destLogical = destinationFor(newType, accountDir, skillName)
  assertWithinHome(destLogical)

  const destPath = isDisabled ? destLogical + '.disabled' : destLogical
  if (fs.existsSync(destPath)) {
    throw new HttpError(409, `Destination already exists: ${destPath}`)
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  fs.renameSync(sourcePath, destPath)

  // Audit log so we can debug user-reported "where did my skill go" issues.
  fs.mkdirSync(LOADOUT_DIR, { recursive: true })
  fs.appendFileSync(
    MOVE_LOG_PATH,
    JSON.stringify({
      from: sourcePath,
      to: destPath,
      timestamp: new Date().toISOString(),
      id: pathParam(req, 'id'),
    }) + '\n',
  )

  res.json({ ok: true, from: sourcePath, to: destPath, newId: encodeSkillId(destLogical) })
}))

router.post('/skills/:id/open', asyncHandler(async (req, res) => {
  const filePath = decodeSkillId(req.params.id)
  assertWithinHome(filePath)
  await openInSystem(filePath)
  res.json({ ok: true })
}))

// Inline edit of description and/or body. Only file-backed artifacts (skill,
// command, subagent) — MCP servers are config-derived and have no
// description/body file to rewrite, so they get 400.
router.patch('/skills/:id', asyncHandler((req, res) => {
  const { description, body } = req.body as { description?: string; body?: string }
  if (description === undefined && body === undefined) {
    throw new HttpError(400, 'Provide description and/or body to update')
  }
  if (description !== undefined && typeof description !== 'string') {
    throw new HttpError(400, 'description must be a string')
  }
  if (body !== undefined && typeof body !== 'string') {
    throw new HttpError(400, 'body must be a string')
  }

  const logicalPath = decodeSkillId(req.params.id)
  assertWithinHome(logicalPath)

  // Pick whichever file actually exists (enabled vs. .disabled suffix). The
  // logical path is what the scanner used to derive the id, so following
  // either suffix here keeps disabled skills editable too.
  const targetPath = fs.existsSync(logicalPath)
    ? logicalPath
    : fs.existsSync(logicalPath + '.disabled')
      ? logicalPath + '.disabled'
      : null
  if (!targetPath) throw new HttpError(404, 'Skill file not found')

  // Follow symlinks so the user's authoritative source updates, not the
  // symlink target's mirror. Stat-then-realpath avoids surprises when the
  // logical path is itself a symlink into another loadout directory.
  let writePath = targetPath
  try {
    if (fs.lstatSync(targetPath).isSymbolicLink()) {
      writePath = fs.realpathSync(targetPath)
      assertWithinHome(writePath)
    }
  } catch { /* fall back to targetPath */ }

  try {
    updateSkillFile(writePath, { description, body })
  } catch (err) {
    if (err instanceof FrontmatterWriteError) {
      throw new HttpError(400, err.message)
    }
    throw err
  }

  res.json({ ok: true })
}))

router.post('/skills/:id/uninstall', asyncHandler((req, res) => {
  const logicalPath = decodeSkillId(req.params.id)
  assertWithinHome(logicalPath)

  const actualPath = fs.existsSync(logicalPath)
    ? logicalPath
    : fs.existsSync(logicalPath + '.disabled')
      ? logicalPath + '.disabled'
      : null
  if (!actualPath) throw new HttpError(404, 'Skill file not found')

  const inventory = discoverAllSkills()
  const skill = inventory.find(s => s.realpath === logicalPath || s.path === actualPath)
  if (!skill) throw new HttpError(404, 'Skill not found in inventory')

  // Prefer realpath so symlinked skills move physically (and restore correctly later).
  const physicalPath = skill.realpath || actualPath
  uninstallSkill(pathParam(req, 'id'), physicalPath, {
    name: skill.name,
    description: skill.description,
    type: skill.type,
    scope: skill.scope,
    account: skill.account,
  })
  res.json({ ok: true })
}))

export default router

// ─── Helpers (reclassify) ────────────────────────────────────────────────────

interface ParsedLogicalPath {
  currentType: 'skill' | 'command' | 'subagent'
  name: string
  accountDir: string
}

// Path conventions:
//   <account>/skills/<name>/SKILL.md   → skill
//   <account>/commands/<name>.md       → command
//   <account>/agents/<name>.md         → subagent
function parseLogicalPath(logicalPath: string): ParsedLogicalPath {
  const fileName = path.basename(logicalPath)
  if (fileName === 'SKILL.md') {
    return {
      currentType: 'skill',
      name: path.basename(path.dirname(logicalPath)),
      accountDir: path.dirname(path.dirname(path.dirname(logicalPath))),
    }
  }
  const parentFolder = path.basename(path.dirname(logicalPath))
  if (parentFolder === 'commands') {
    return {
      currentType: 'command',
      name: path.basename(logicalPath, '.md'),
      accountDir: path.dirname(path.dirname(logicalPath)),
    }
  }
  if (parentFolder === 'agents') {
    return {
      currentType: 'subagent',
      name: path.basename(logicalPath, '.md'),
      accountDir: path.dirname(path.dirname(logicalPath)),
    }
  }
  throw new HttpError(400, 'Namespaced commands are not supported for reclassify')
}

function destinationFor(
  newType: 'skill' | 'command' | 'subagent' | string,
  accountDir: string,
  name: string,
): string {
  if (newType === 'skill') return path.join(accountDir, 'skills', name, 'SKILL.md')
  if (newType === 'command') return path.join(accountDir, 'commands', name + '.md')
  return path.join(accountDir, 'agents', name + '.md')
}
