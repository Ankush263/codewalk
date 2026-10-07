import { Router } from 'express';
import { patientsRouter } from './patients';

export const apiRouter = Router();

apiRouter.use('/patients', patientsRouter);
