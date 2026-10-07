import { useState, type ChangeEvent, type FormEvent } from 'react';
import { FormField } from './FormField';
import { useEnrollMutation } from '../hooks/useEnrollMutation';
import type { EnrollFormValues, PatientDto } from '../types';

interface EnrollFormProps {
  onEnrolled: (patient: PatientDto) => void;
}

const EMPTY_FORM: EnrollFormValues = {
  firstName: '',
  lastName: '',
  phone: '',
  dateOfBirth: '',
  consentGiven: false,
};

export function EnrollForm({ onEnrolled }: EnrollFormProps) {
  const [values, setValues] = useState<EnrollFormValues>(EMPTY_FORM);
  const { mutate, status, error } = useEnrollMutation({
    onSuccess: (patient) => {
      setValues(EMPTY_FORM);
      onEnrolled(patient);
    },
  });

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const { name, value, type, checked } = e.target;
    setValues((prev) => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!values.consentGiven) return;
    mutate(values);
  }

  return (
    <form onSubmit={handleSubmit}>
      <FormField label="First name" name="firstName" value={values.firstName} onChange={handleChange} />
      <FormField label="Last name" name="lastName" value={values.lastName} onChange={handleChange} />
      <FormField label="Phone" name="phone" type="tel" value={values.phone} onChange={handleChange} />
      <FormField label="Date of birth" name="dateOfBirth" type="date" value={values.dateOfBirth} onChange={handleChange} />
      <label>
        <input name="consentGiven" type="checkbox" checked={values.consentGiven} onChange={handleChange} />
        I consent to enrollment
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={status === 'submitting' || !values.consentGiven}>
        {status === 'submitting' ? 'Enrolling…' : 'Enroll'}
      </button>
    </form>
  );
}
