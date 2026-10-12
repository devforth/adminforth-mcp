import { z } from 'zod';

/** One confirmation in the admin panel covers at most this many pending actions, all shown to the user. */
export const MAX_ACTIONS_PER_CONFIRMATION = 20;

const confirmationIds = z.array(z.string()).min(1).max(MAX_ACTIONS_PER_CONFIRMATION);
const runConfirmationBody = z.object({
  ids: confirmationIds,
  verificationResult: z.record(z.string(), z.unknown()),
});
const declineConfirmationBody = z.object({ ids: confirmationIds });
export type RunConfirmationBody = z.infer<typeof runConfirmationBody>;
export type DeclineConfirmationBody = z.infer<typeof declineConfirmationBody>;

// Convert with the same Zod version that created the schema. AdminForth may use another version.
export const runConfirmationBodySchema = z.toJSONSchema(runConfirmationBody, { target: 'draft-07' });
export const declineConfirmationBodySchema = z.toJSONSchema(declineConfirmationBody, { target: 'draft-07' });
