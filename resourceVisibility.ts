import {
  ActionCheckSource,
  interpretResource,
  type AdminForthResource,
  type AdminUser,
  type IAdminForth,
} from 'adminforth';

export class McpResourceVisibility {
  constructor(private readonly adminforth: IAdminForth) {}

  async visibleResources(adminUser: AdminUser): Promise<AdminForthResource[]> {
    const resources = this.adminforth.config.resources;
    const visible = await Promise.all(resources.map((resource) => this.canListOrShow(adminUser, resource)));
    return resources.filter((_, index) => visible[index]);
  }

  async isVisible(adminUser: AdminUser, resourceId: string): Promise<boolean> {
    const resource = this.adminforth.config.resources.find((candidate) => candidate.resourceId === resourceId);
    return resource !== undefined && this.canListOrShow(adminUser, resource);
  }

  private async canListOrShow(adminUser: AdminUser, resource: AdminForthResource): Promise<boolean> {
    if (resource.options.agent?.hiddenFromAgents) return false;
    const [{ allowedActions: { list } }, { allowedActions: { show } }] = await Promise.all([
      interpretResource(adminUser, resource, {}, ActionCheckSource.ListRequest, this.adminforth),
      interpretResource(adminUser, resource, {}, ActionCheckSource.ShowRequest, this.adminforth),
    ]);
    return list === true || show === true;
  }
}
