import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import { exec } from 'child_process'
import { discoverAllSkills } from '../scanner'
import { disableSkill, enableSkill } from '../state'
import { uninstallSkill } from '../state/uninstall'
import { asyncHandler } from '../lib/asyncHandler'
import { decodeSkillId, encodeSkillId } from '../lib/ids'
import { pathParam } from '../lib/params'
import { assertWithinHome, HttpError, LOADOUT_DIR, MOVE_LOG_PATH } from '../lib/paths'

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

router.post('/skills/:id/open', asyncHandler((req, res) => {
  const filePath = decodeSkillId(req.params.id)
  assertWithinHome(filePath)

  // Platform-specific "open this file in the user's default app" command.
  let cmd: string
  if (process.platform === 'darwin') cmd = 'open'
  else if (process.platform === 'win32') cmd = 'start ""'
  else cmd = 'xdg-open'

  exec(`${cmd} ${JSON.stringify(filePath)}`, (err) => {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    res.json({ ok: true })
  })
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
