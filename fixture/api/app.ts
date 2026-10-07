import express from 'express';
import { apiRouter } from './routes';
import { errorHandler } from './middleware/errorHandler';
import { registerEventHandlers } from './events/bus';

export function createApp() {
  const app = express();

  app.use(express.json());
  app.use('/api', apiRouter);
  app.use(errorHandler);

  registerEventHandlers();
  return app;
}
