import { logger, type IAdminForth } from 'adminforth';
import type { McpAuthSecretStore } from '../authSecretStore.js';
import type { PluginOptions } from '../types.js';
import { CONSENT_PAGE_PATH, type McpUrls } from '../urls.js';
import { McpOAuth } from './authorizationServer.js';
import { isLoopbackUrl } from './redirectUris.js';

export function setupOAuth(
  adminforth: IAdminForth,
  authSecretStore: McpAuthSecretStore,
  urls: McpUrls,
  options: PluginOptions,
  consentPageFile: string,
): McpOAuth {
  // OAuth sends codes and tokens through these endpoints, so they must be served over TLS (RFC 6749 §3.1);
  // plain http is left for a local admin panel.
  const origin = new URL(urls.adminPanelUrl);
  if (origin.protocol !== 'https:' && !isLoopbackUrl(origin)) {
    throw new Error(
      `AdminForthMcpPlugin: adminPanelOrigin must use https with OAuth sign-in, got "${origin.origin}"; `
      + 'http is allowed only for localhost and 127.0.0.1',
    );
  }

  adminforth.config.customization.customPages.push({
    path: CONSENT_PAGE_PATH,
    component: {
      file: consentPageFile,
      meta: { sidebarAndHeader: 'none' },
    },
  });

  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction && options.devOAuthClients?.length) {
    logger.warn('AdminForthMcpPlugin: devOAuthClients are ignored because NODE_ENV is "production"');
  }
  return new McpOAuth(
    adminforth,
    authSecretStore,
    urls,
    isProduction ? [] : options.devOAuthClients,
    options.readOnly,
  );
}
