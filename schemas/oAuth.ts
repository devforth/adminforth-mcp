import { z } from 'zod';

export const resolveAuthorizationBodySchema = z.object({
  request: z.string(),
  approved: z.boolean(),
  readOnly: z.boolean(),
});

export const clientMetadataDocumentSchema = z.object({
  client_id: z.string(),
  client_name: z.string(),
  redirect_uris: z.array(z.string().refine((uri) => URL.canParse(uri))).min(1),
  token_endpoint_auth_method: z.literal('none'),
});

export type ResolveAuthorizationBody = z.infer<typeof resolveAuthorizationBodySchema>;
