import type { NextFunction, Request, Response } from 'express';
import { redis } from '../db/redis';
import { UnauthorizedError } from '../errors';

export interface SessionUser {
  id: string;
  role: 'admin' | 'staff';
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) {
    return next(new UnauthorizedError('Missing bearer token'));
  }

  const raw = await redis.get(`session:${token}`);
  if (!raw) {
    return next(new UnauthorizedError('Session expired'));
  }

  (req as Request & { user: SessionUser }).user = JSON.parse(raw) as SessionUser;
  next();
}
