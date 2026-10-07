import { usePatient } from '../hooks/usePatient';

export function PatientSummary({ patientId }: { patientId: string }) {
  const { patient, loading } = usePatient(patientId);

  if (loading) return <p>Loading…</p>;
  if (!patient) return <p>Patient not found.</p>;

  return (
    <section>
      <h2>
        {patient.firstName} {patient.lastName}
      </h2>
      <p>Phone: {patient.phone}</p>
    </section>
  );
}
