import { z } from 'zod';

const runConfirmationBody = z.object({
  id: z.string(),
  verificationResult: z.record(z.string(), z.unknown()),
});
const declineConfirmationBody = z.object({ id: z.string() });
export type RunConfirmationBody = z.infer<typeof runConfirmationBody>;
export type DeclineConfirmationBody = z.infer<typeof declineConfirmationBody>;

// Convert with the same Zod version that created the schema. AdminForth may use another version.
export const runConfirmationBodySchema = z.toJSONSchema(runConfirmationBody, { target: 'draft-07' });
export const declineConfirmationBodySchema = z.toJSONSchema(declineConfirmationBody, { target: 'draft-07' });
