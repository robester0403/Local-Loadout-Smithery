// Express handler wrapper that lets routes use plain throw/await syntax
// without try/catch boilerplate. HttpError instances are mapped to their
// declared status; anything else becomes a 500 with the error message.

import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { HttpError } from './paths'

type HandlerFn = (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>

export function asyncHandler(fn: HandlerFn): RequestHandler {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res, next))
      .catch((err: unknown) => {
        if (res.headersSent) {
          // The handler already responded then threw afterward — let express
          // surface the secondary error in its logs but don't double-respond.
          next(err as Error)
          return
        }
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.message })
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        res.status(500).json({ error: message })
      })
  }
}
