import { pool } from '../db/pool';
import { redis } from '../db/redis';
import { bus } from '../events/bus';
import { ConflictError, NotFoundError } from '../errors';
import type { EnrollInput } from '../schemas/enroll';
import {
  findPatientById,
  findPatientByPhone,
  insertConsent,
  insertPatient,
  type Patient,
} from '../repositories/patientRepository';

const PATIENT_CACHE_TTL_SECONDS = 300;

/** Strips formatting and keeps the last 10 digits, e.g. "+91 98765-43210" -> "9876543210". */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.slice(-10);
}

/** Whole years between dateOfBirth (YYYY-MM-DD) and `today`. */
export function calculateAge(dateOfBirth: string, today: Date = new Date()): number {
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  let age = today.getUTCFullYear() - dob.getUTCFullYear();
  const birthdayPassed =
    today.getUTCMonth() > dob.getUTCMonth() ||
    (today.getUTCMonth() === dob.getUTCMonth() && today.getUTCDate() >= dob.getUTCDate());
  if (!birthdayPassed) {
    age -= 1;
  }
  return age;
}

export async function enrollPatient(input: EnrollInput, enrolledBy: string): Promise<Patient> {
  const phone = normalizePhone(input.phone);
  const age = calculateAge(input.dateOfBirth);
  if (age < 18) {
    throw new ConflictError('Patient must be 18 or older to self-enroll');
  }

  const existing = await findPatientByPhone(phone);
  if (existing) {
    throw new ConflictError(`Patient with phone ${phone} is already enrolled`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const patient = await insertPatient(client, {
      firstName: input.firstName,
      lastName: input.lastName,
      phone,
      dateOfBirth: input.dateOfBirth,
      enrolledBy,
    });
    await insertConsent(client, patient.id, enrolledBy);
    await client.query('COMMIT');

    await redis.set(`patient:${patient.id}`, JSON.stringify(patient), 'EX', PATIENT_CACHE_TTL_SECONDS);
    bus.emit('patient.enrolled', patient);
    return patient;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getPatient(id: string): Promise<Patient> {
  const cached = await redis.get(`patient:${id}`);
  if (cached) {
    return JSON.parse(cached) as Patient;
  }
  const patient = await findPatientById(id);
  if (!patient) {
    throw new NotFoundError(`Patient ${id} not found`);
  }
  return patient;
}
