import type { AdminUser } from 'adminforth';
import type { PluginOptions } from './types.js';

export type ServerReadOnly = (adminUser: AdminUser) => Promise<boolean>;

export function createServerReadOnly(readOnly: PluginOptions['readOnly'] = false): ServerReadOnly {
  return async (adminUser) => (typeof readOnly === 'function' ? readOnly({ adminUser }) : readOnly);
}
