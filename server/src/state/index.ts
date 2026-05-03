import fs from 'fs'
import os from 'os'

function decodePath(id: string): string {
  const filePath = Buffer.from(id, 'base64').toString('utf-8')
  if (!filePath.startsWith(os.homedir())) {
    throw new Error('Path outside home directory')
  }
  return filePath
}

export function disableSkill(id: string): void {
  const filePath = decodePath(id)
  const disabledPath = filePath + '.disabled'
  if (!fs.existsSync(filePath)) {
    if (fs.existsSync(disabledPath)) return // already disabled
    throw new Error(`Skill file not found: ${filePath}`)
  }
  fs.renameSync(filePath, disabledPath)
}

export function enableSkill(id: string): void {
  const filePath = decodePath(id)
  const disabledPath = filePath + '.disabled'
  if (!fs.existsSync(disabledPath)) {
    if (fs.existsSync(filePath)) return // already enabled
    throw new Error(`Disabled skill file not found: ${disabledPath}`)
  }
  fs.renameSync(disabledPath, filePath)
}
