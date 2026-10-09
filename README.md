# AdminForth MCP

`@adminforth/mcp` exposes the AdminForth API tool surface as an authenticated remote MCP server. Agents connect through OAuth sign-in or with an auth secret, and act as the AdminForth user who connected them, so resource permissions and hooks are preserved.

The required `adminPanelOrigin` is the public origin agents connect to; the plugin combines it with the AdminForth `baseUrl` to build the MCP URL and the OAuth issuer.

> **Security:** an MCP auth secret carries the full permissions of the user who created it. An agent
> holding it can do everything that user can do in the admin panel, including destructive actions and
> changes to that user's security settings. Issue one secret per agent, treat it like a password, and
> revoke it as soon as the agent or its machine is compromised.

Install with:

```bash
pnpm add @adminforth/mcp
```

See the [AdminForth MCP documentation](https://adminforth.dev/docs/tutorial/Plugins/mcp/) for the auth secret table and plugin configuration.
