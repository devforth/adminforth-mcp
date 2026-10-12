import type { HttpExtra, IAdminForth } from 'adminforth';

export interface ContextualTwoFactorsAuth {
  withVerificationContext<T>(verificationResult: Record<string, unknown> | undefined, extra: HttpExtra, callback: () => Promise<T>): Promise<unknown>;
}

/** Only newer 2FA plugins can verify verifyAuto calls within an external request. */
export function findContextualTwoFactorsAuth(adminforth: IAdminForth): ContextualTwoFactorsAuth | undefined {
  const plugin = adminforth.getPluginsByClassName<Partial<ContextualTwoFactorsAuth>>('TwoFactorsAuthPlugin')[0];
  return plugin?.withVerificationContext ? plugin as ContextualTwoFactorsAuth : undefined;
}
