// AdminForth core reports a beforeSave hook that returned { ok: false, error: null } with this error.
// The hook saved the record itself and may point to it with redirectToRecordId; the admin panel treats it as a success.
const HOOK_ABORT_ERROR = 'Operation aborted by hook';

export function isErrorOutput(status: number, output: unknown): boolean {
  if (status >= 400) return true;
  if (!output || typeof output !== 'object') return false;
  const { error, ok } = output as { error?: unknown; ok?: unknown };
  if (error === HOOK_ABORT_ERROR) return false;
  return 'error' in output || ok === false;
}
