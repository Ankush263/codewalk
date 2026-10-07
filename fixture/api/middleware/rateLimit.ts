import type { NextFunction, Request, Response } from 'express';
import { redis } from '../db/redis';
import { TooManyRequestsError } from '../errors';

const WINDOW_SECONDS = 60;
const MAX_REQUESTS = 10;

export async function rateLimit(req: Request, _res: Response, next: NextFunction) {
  const key = `ratelimit:${req.ip}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, WINDOW_SECONDS);
  }
  if (count > MAX_REQUESTS) {
    return next(new TooManyRequestsError());
  }
  next();
}
