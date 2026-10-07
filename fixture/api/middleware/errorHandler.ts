import type { NextFunction, Request, Response } from 'express';
import { HttpError, ValidationError } from '../errors';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ValidationError) {
    return res.status(err.status).json({ error: err.message, issues: err.issues });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}
