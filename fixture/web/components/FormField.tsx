import type { ChangeEvent } from 'react';

interface FormFieldProps {
  label: string;
  name: string;
  value: string;
  type?: 'text' | 'tel' | 'date';
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
}

export function FormField({ label, name, value, type = 'text', onChange }: FormFieldProps) {
  return (
    <label>
      {label}
      <input name={name} type={type} value={value} onChange={onChange} />
    </label>
  );
}
