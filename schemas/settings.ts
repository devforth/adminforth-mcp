import { z } from 'zod';

export const createAuthSecretBodySchema = z.object({
  name: z.string().min(1),
  readOnly: z.boolean(),
});

export const revokeAuthSecretBodySchema = z.object({
  id: z.string(),
});

export type CreateAuthSecretBody = z.infer<typeof createAuthSecretBodySchema>;
export type RevokeAuthSecretBody = z.infer<typeof revokeAuthSecretBodySchema>;
