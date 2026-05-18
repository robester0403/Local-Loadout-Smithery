import { exec } from 'child_process'

// Open a file in the host OS's default application. Returns a promise that
// resolves on success and rejects on failure, so route handlers can await it
// and let asyncHandler's catch path surface errors uniformly.
export function openInSystem(filePath: string): Promise<void> {
  const cmd = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'start ""'
      : 'xdg-open'
  return new Promise((resolve, reject) => {
    exec(`${cmd} ${JSON.stringify(filePath)}`, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}
