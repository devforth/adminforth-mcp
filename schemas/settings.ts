import { z } from 'zod';

export const createAuthSecretBodySchema = z.object({
  name: z.string().min(1),
  readOnly: z.boolean(),
});

export const revokeAuthSecretBodySchema = z.object({
  id: z.string(),
});

export const updateAuthSecretBodySchema = z.object({
  id: z.string(),
  readOnly: z.boolean(),
});

export type CreateAuthSecretBody = z.infer<typeof createAuthSecretBodySchema>;
export type RevokeAuthSecretBody = z.infer<typeof revokeAuthSecretBodySchema>;
export type UpdateAuthSecretBody = z.infer<typeof updateAuthSecretBodySchema>;
