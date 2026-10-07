export interface EnrollFormValues {
  firstName: string;
  lastName: string;
  phone: string;
  dateOfBirth: string;
  consentGiven: boolean;
}

export interface PatientDto {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  dateOfBirth: string;
}
