# AdminForth MCP

`@adminforth/mcp` exposes the AdminForth API tool surface as an authenticated remote MCP server. Each MCP auth secret belongs to one AdminForth user, so resource permissions and hooks are preserved.

The server identifies itself to agents using the configured AdminForth `brandName`. An optional `adminPanelOrigin` can distinguish deployments further; the plugin combines it with the AdminForth `baseUrl`.

> **Security:** an MCP auth secret carries the full permissions of the user who created it. An agent
> holding it can do everything that user can do in the admin panel, including destructive actions and
> changes to that user's security settings. Issue one secret per agent, treat it like a password, and
> revoke it as soon as the agent or its machine is compromised.

Install with:

```bash
pnpm add @adminforth/mcp
```

See the [AdminForth MCP documentation](https://adminforth.dev/docs/tutorial/Plugins/mcp/) for the auth secret table and plugin configuration.
