import type { IAdminForth, IHttpServer } from 'adminforth';
import { resourcesListResponseSchema } from '../schemas/tools.js';

export function registerToolEndpoints(server: IHttpServer, adminforth: IAdminForth): void {
  server.endpoint({
    method: 'GET',
    path: '/get_resources_list',
    description: 'Lists the resourceId and label of every resource (data table), including resources the user cannot access: access is checked when a resource is used. Call this first to discover valid resourceId values before using get_resource, get_resource_data, aggregate, create_record, update_record, delete_record or other resource tools.',
    agent: {
      onlyReadsData: true,
    },
    response_schema: resourcesListResponseSchema,
    handler: async ({ tr }) => {
      const resources = await Promise.all(adminforth.config.resources.map(async (resource) => ({
        resourceId: resource.resourceId,
        label: await tr(resource.label, `resource.${resource.resourceId}`),
      })));

      return { resources };
    },
  });
}
