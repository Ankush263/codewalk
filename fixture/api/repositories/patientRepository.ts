import type { PoolClient } from 'pg';
import { pool } from '../db/pool';

export interface Patient {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  dateOfBirth: string;
  enrolledBy: string;
  createdAt: string;
}

export type NewPatient = Omit<Patient, 'id' | 'createdAt'>;

const PATIENT_COLUMNS = `id, first_name AS "firstName", last_name AS "lastName", phone,
  date_of_birth AS "dateOfBirth", enrolled_by AS "enrolledBy", created_at AS "createdAt"`;

export async function findPatientByPhone(phone: string): Promise<Patient | null> {
  const { rows } = await pool.query<Patient>(
    `SELECT ${PATIENT_COLUMNS} FROM patients WHERE phone = $1`,
    [phone],
  );
  return rows[0] ?? null;
}

export async function findPatientById(id: string): Promise<Patient | null> {
  const { rows } = await pool.query<Patient>(
    `SELECT ${PATIENT_COLUMNS} FROM patients WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function insertPatient(client: PoolClient, patient: NewPatient): Promise<Patient> {
  const { rows } = await client.query<Patient>(
    `INSERT INTO patients (first_name, last_name, phone, date_of_birth, enrolled_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${PATIENT_COLUMNS}`,
    [patient.firstName, patient.lastName, patient.phone, patient.dateOfBirth, patient.enrolledBy],
  );
  return rows[0];
}

export async function insertConsent(client: PoolClient, patientId: string, capturedBy: string) {
  await client.query(
    `INSERT INTO consents (patient_id, captured_by, captured_at) VALUES ($1, $2, now())`,
    [patientId, capturedBy],
  );
}
