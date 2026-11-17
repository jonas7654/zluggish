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

export const newUser = z.strictObject({
  username: loginName,
  password,
  first_name: z.string().trim().min(1).max(50),
  last_name: z.string().trim().max(50),
});

export const setupRequest = z.union([
  newUser.extend({ mode: z.literal('new'), key: z.string().max(200) }),
  credentials.extend({ mode: z.literal('existing'), key: z.string().max(200) }),
  z.strictObject({
    mode: z.literal('existing'),
    key: z.string().max(200),
    player_id: z.number().int().positive().safe(),
    password,
  }),
]);

export const mutationRequest = z.strictObject({
  revision: z.number().int().positive(),
  operation: z.string().uuid(),
  password: password.optional(),
  role: z.enum(['rider', 'administrator']).optional(),
});

export const editUserRequest = z.strictObject({
  revision: z.number().int().positive(),
  operation: z.string().uuid(),
  username: loginName,
  first_name: z.string().trim().min(1).max(50),
  last_name: z.string().trim().max(50),
});

export const ownProfileRequest = z.strictObject({
  revision: z.number().int().positive(),
  operation: z.string().uuid(),
  username: loginName,
  first_name: z.string().trim().min(1).max(50),
  last_name: z.string().trim().max(50),
  birthday: z.union([z.literal(''), z.iso.date()]),
});

export const settingsRequest = z.strictObject({
  revision: z.number().int().nonnegative(),
  operation: z.string().uuid(),
  overrides: overrideSchema,
});

export type JsonValue =
  | string
  | number
  | boolean
  | readonly JsonValue[]
  | { [key: string]: JsonValue }
  | null
  | undefined;

export const eventRequest = z.strictObject({
  operation: z.string().uuid(),
  revision: z.string(),
  changes: meetupInput.partial().strict().optional(),
});

/** Chat commands that change bots for every user. Only the management area may send them. */
export const botCommand = z.enum([
  'group',
  'groupall',
  'autogroup',
  'autogroupall',
  'stopautogroup',
  'disperse',
  'peloton',
]);

export const serverRequest = z.strictObject({
  operation: z.string().uuid(),
  user: z.number().int().positive().optional(),
  command: botCommand.optional(),
  argument: z.string().trim().max(20).optional(),
});

export const worldRequest = z.strictObject({
  operation: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  id: z.string().max(100),
  values: z.record(z.string(), z.json()),
});
