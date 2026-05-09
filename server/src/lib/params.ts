// Path-parameter accessor that narrows Express v5's `string | string[]` typing
// to plain string. Express never produces an array for `:foo` route params at
// runtime — only repeated query strings — but the types must accommodate both.

import type { Request } from 'express'
import { HttpError } from './paths'

export function pathParam(req: Request, key: string): string {
  const v = req.params[key]
  if (typeof v !== 'string' || v.length === 0) {
    throw new HttpError(400, `Missing or invalid path parameter: ${key}`)
  }
  return v
}
