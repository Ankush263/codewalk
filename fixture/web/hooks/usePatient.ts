import { useEffect, useState } from 'react';
import { api } from '../apiClient';
import type { PatientDto } from '../types';

export function usePatient(id: string) {
  const [patient, setPatient] = useState<PatientDto | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<PatientDto>(`/api/patients/${id}`)
      .then((data) => {
        if (!cancelled) setPatient(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return { patient, loading };
}
