import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import { enrollSchema } from '../schemas/enroll';
import { enrollHandler, getPatientHandler } from '../controllers/patientsController';

export const patientsRouter = Router();

// Router-level middleware: runs before every route below.
patientsRouter.use(requireAuth);

patientsRouter.post('/enroll', rateLimit, validate(enrollSchema), enrollHandler);
patientsRouter.get('/:id', getPatientHandler);
