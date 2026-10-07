import type { NextFunction, Request, Response } from 'express';
import type { ZodSchema } from 'zod';
import { ValidationError } from '../errors';

export function validate(schema: ZodSchema) {
  return function validateBody(req: Request, _res: Response, next: NextFunction) {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      return next(new ValidationError(issues));
    }
    req.body = result.data;
    next();
  };
}
