import { inputSchema as meetupInput } from '#src/dtos/meetup.dto';
import { overrideSchema } from '#src/dtos/settings.dto';
import { z } from 'zod';

export function normalizeLoginName(value: string) {
  return value.trim().toLowerCase();
}

export const loginName = z
  .string()
  .transform(normalizeLoginName)
  .pipe(
    z
      .string()
      .min(1)
      .max(254)
      .refine((value) => !/[\s\0]/.test(value), 'Enter a login name without spaces.'),
  );

export const password = z.string().min(1).max(1024);
export const credentials = z.strictObject({ username: loginName, password });

export const newRider = z.strictObject({
  username: loginName,
  password,
  first_name: z.string().trim().min(1).max(50),
  last_name: z.string().trim().max(50),
});

export const setupRequest = z.union([
  newRider.extend({ mode: z.literal('new'), key: z.string().max(200) }),
  credentials.extend({ mode: z.literal('existing'), key: z.string().max(200) }),
]);

export const mutationRequest = z.strictObject({
  revision: z.number().int().positive(),
  operation: z.string().uuid(),
  password: password.optional(),
  role: z.enum(['rider', 'administrator']).optional(),
});

export const editRiderRequest = z.strictObject({
  revision: z.number().int().positive(),
  operation: z.string().uuid(),
  username: loginName,
  first_name: z.string().trim().min(1).max(50),
  last_name: z.string().trim().max(50),
});

export const settingsRequest = z.strictObject({
  revision: z.number().int().nonnegative(),
  operation: z.string().uuid(),
  overrides: overrideSchema,
});

export type AuditValue =
  | string
  | number
  | boolean
  | readonly AuditValue[]
  | { [key: string]: AuditValue }
  | null
  | undefined;

export const eventRequest = z.strictObject({
  operation: z.string().uuid(),
  revision: z.string(),
  changes: meetupInput.partial().strict().optional(),
});

export const worldRequest = z.strictObject({
  operation: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  id: z.string().max(100),
  values: z.record(z.string(), z.json()),
});
