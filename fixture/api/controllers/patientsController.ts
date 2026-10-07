import type { NextFunction, Request, Response } from 'express';
import type { SessionUser } from '../middleware/auth';
import { enrollPatient, getPatient } from '../services/enrollService';

type AuthedRequest = Request & { user: SessionUser };

export async function enrollHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { user } = req as AuthedRequest;
    const patient = await enrollPatient(req.body, user.id);
    res.status(201).json(patient);
  } catch (err) {
    next(err);
  }
}

export async function getPatientHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const patient = await getPatient(req.params.id);
    res.json(patient);
  } catch (err) {
    next(err);
  }
}
