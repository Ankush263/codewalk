import { useState } from 'react';
import { api, ApiError } from '../apiClient';
import type { EnrollFormValues, PatientDto } from '../types';

type Status = 'idle' | 'submitting' | 'success' | 'error';

interface Options {
  onSuccess?: (patient: PatientDto) => void;
}

export function useEnrollMutation({ onSuccess }: Options = {}) {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  async function mutate(values: EnrollFormValues) {
    setStatus('submitting');
    setError(null);
    try {
      const patient = await api.post<PatientDto>('/api/patients/enroll', values);
      setStatus('success');
      onSuccess?.(patient);
    } catch (err) {
      setStatus('error');
      setError(err instanceof ApiError && err.status === 409 ? 'This patient is already enrolled.' : 'Enrollment failed.');
    }
  }

  return { mutate, status, error };
}
