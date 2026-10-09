import { z } from 'zod';

export const resourcesListResponseSchema = z.object({
  resources: z.array(z.object({
    resourceId: z.string().describe('Resource identifier. Pass it as resourceId to get_resource, get_resource_data, aggregate, create_record, update_record, delete_record and other resource tools. Call get_resource with it to get the columns and allowed actions of the resource.'),
    label: z.string().describe('Human readable resource name, translated for the current user.'),
  })).describe('Every resource of the admin panel. Access is checked when a resource is used, so the user may still be forbidden to list, show, create, edit or delete records of a listed resource.'),
});
