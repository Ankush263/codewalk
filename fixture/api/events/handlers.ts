import type { Patient } from '../repositories/patientRepository';

type Handler = (payload: unknown) => Promise<void>;

async function sendWelcomeSms(payload: unknown) {
  const patient = payload as Patient;
  await fetch('https://sms.example.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: patient.phone, text: `Welcome, ${patient.firstName}!` }),
  });
}

async function notifyCareTeam(payload: unknown) {
  const patient = payload as Patient;
  await fetch('https://care.example.com/hooks/new-patient', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patientId: patient.id }),
  });
}

const handlers: Record<string, Handler> = { sendWelcomeSms, notifyCareTeam };

// Deliberately dynamic: the callee depends on the runtime value of `name`.
export function dispatch(name: string, payload: unknown) {
  const handler = handlers[name];
  if (!handler) {
    throw new Error(`No handler registered for ${name}`);
  }
  return handlers[name](payload);
}
