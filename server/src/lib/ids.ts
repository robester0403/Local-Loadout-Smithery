// Skill IDs are base64-encoded filesystem paths. Routes accept the encoded
// form on the wire and decode at the entry point. These helpers raise a 400
// HttpError on malformed input so handlers don't repeat the try/catch.

import { HttpError, assertAllowedSkillPath } from './paths'

// Accepts the broader type Express v5 declares for path/query params
// (`string | string[] | undefined`) and rejects anything that isn't a string.
// The decoded path is also gated through assertAllowedSkillPath so a crafted
// id can't be used to read/write arbitrary files under $HOME — without this
// guard, every PATCH /skills/:id route is a path-traversal write primitive.
export function decodeSkillId(encoded: string | string[] | undefined): string {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new HttpError(400, 'Invalid id')
  }
  let decoded: string
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf-8')
  } catch {
    throw new HttpError(400, 'Invalid id')
  }
  assertAllowedSkillPath(decoded)
  return decoded
}

export function encodeSkillId(filePath: string): string {
  return Buffer.from(filePath).toString('base64')
}
