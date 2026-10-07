import { EventEmitter } from 'node:events';
import { dispatch } from './handlers';

export const bus = new EventEmitter();

// Deliberately dynamic: listeners are wired by event name at runtime, so a static
// call graph cannot see that `bus.emit('patient.enrolled')` reaches these handlers.
const SUBSCRIPTIONS: Record<string, string[]> = {
  'patient.enrolled': ['sendWelcomeSms', 'notifyCareTeam'],
};

export function registerEventHandlers() {
  for (const [event, handlerNames] of Object.entries(SUBSCRIPTIONS)) {
    for (const name of handlerNames) {
      bus.on(event, (payload: unknown) => dispatch(name, payload));
    }
  }
}
