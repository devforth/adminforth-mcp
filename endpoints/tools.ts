import type { IAdminForth, IHttpServer } from 'adminforth';
import type { McpResourceVisibility } from '../resourceVisibility.js';
import { resourcesListResponseSchema } from '../schemas/tools.js';

export function registerToolEndpoints(
  server: IHttpServer,
  adminforth: IAdminForth,
  resourceVisibility: McpResourceVisibility,
): void {
  server.endpoint({
    method: 'GET',
    path: '/get_resources_list',
    description: 'Lists the resourceId and label of every resource (data table) whose records the user may list or show. Call this first to discover valid resourceId values before using get_resource, get_resource_data, aggregate, create_record, update_record, delete_record or other resource tools.',
    agent: {
      onlyReadsData: true,
    },
    response_schema: resourcesListResponseSchema,
    handler: async ({ adminUser, tr }) => {
      const resources = await Promise.all((await resourceVisibility.visibleResources(adminUser)).map(async (resource) => ({
        resourceId: resource.resourceId,
        label: await tr(resource.label, `resource.${resource.resourceId}`),
      })));

      return { resources };
    },
  });
}
