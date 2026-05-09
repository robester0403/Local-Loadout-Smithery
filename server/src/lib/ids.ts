// Skill IDs are base64-encoded filesystem paths. Routes accept the encoded
// form on the wire and decode at the entry point. These helpers raise a 400
// HttpError on malformed input so handlers don't repeat the try/catch.

import { HttpError } from './paths'

// Accepts the broader type Express v5 declares for path/query params
// (`string | string[] | undefined`) and rejects anything that isn't a string.
export function decodeSkillId(encoded: string | string[] | undefined): string {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new HttpError(400, 'Invalid id')
  }
  try {
    return Buffer.from(encoded, 'base64').toString('utf-8')
  } catch {
    throw new HttpError(400, 'Invalid id')
  }
}

export function encodeSkillId(filePath: string): string {
  return Buffer.from(filePath).toString('base64')
}
