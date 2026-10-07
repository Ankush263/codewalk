import { z } from 'zod';

export const enrollSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().min(10),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  consentGiven: z.literal(true),
});

export type EnrollInput = z.infer<typeof enrollSchema>;
